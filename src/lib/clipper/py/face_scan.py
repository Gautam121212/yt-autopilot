#!/usr/bin/env python3
"""Face-scan a video at 1 fps and emit per-sample face bounding boxes as JSONL.

Replaces the ffmpeg cropdetect heuristic in M5 crop-safety with a real detector. The M4 run
shipped a clip where the subject's face was sliced at the left edge (center-cropped from a
two-shot where she was frame-left) — cropdetect could not catch that because the "active content"
spanned the whole frame; only face position matters, and only face detection catches it.

Usage: face_scan.py --input path.mp4 [--fps 1] [--model short-range]
Output: one JSON line per sample on stdout, plus a final summary line.

Each sample line:
  {"t": 2.0, "w": 1920, "h": 1080, "faces": [{"x": 500, "y": 200, "w": 250, "h": 320, "score": 0.98}]}

Summary line (last):
  {"summary": true, "samples": 60, "frames_with_face": 52, "faces_total": 68,
   "face_center_x_mean": 0.47, "face_center_x_std": 0.08, "centered_ratio": 0.62}
  centered_ratio = fraction of face centers that fall inside the 9:16 center stripe.
"""
import argparse, json, sys

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--fps", type=float, default=1.0, help="samples per second")
    ap.add_argument("--model", choices=["short-range", "full-range"], default="full-range",
                    help="short-range = within ~2m of camera; full-range = up to ~5m")
    args = ap.parse_args()

    try:
        import cv2  # type: ignore
        import mediapipe as mp  # type: ignore
    except ImportError as e:
        print(json.dumps({"error": f"missing dep: {e}; pip install mediapipe opencv-python-headless"}), file=sys.stderr)
        return 2

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        print(json.dumps({"error": f"could not open {args.input}"}), file=sys.stderr)
        return 3

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    step = max(1, int(round(src_fps / args.fps)))

    model_sel = 0 if args.model == "short-range" else 1
    detector = mp.solutions.face_detection.FaceDetection(model_selection=model_sel, min_detection_confidence=0.5)

    # 9:16 center stripe (where a vertical center-crop lands) — this is the "safe zone" for faces.
    stripe_w = height * 9 / 16
    stripe_x0 = (width - stripe_w) / 2
    stripe_x1 = stripe_x0 + stripe_w

    samples = 0
    frames_with_face = 0
    faces_total = 0
    face_centers_x = []
    centered = 0
    multi_face_frames = 0        # frames with ≥2 faces separated by width/4+ (interacting pair)
    opposite_third_frames = 0    # frames with faces at both the left and right outer thirds

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx % step != 0:
            frame_idx += 1
            continue
        t = frame_idx / src_fps
        samples += 1
        # Mediapipe wants RGB.
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        result = detector.process(rgb)
        faces = []
        if result.detections:
            frames_with_face += 1
            frame_face_centers = []
            for det in result.detections:
                rb = det.location_data.relative_bounding_box
                fx, fy, fw, fh = rb.xmin * width, rb.ymin * height, rb.width * width, rb.height * height
                score = float(det.score[0]) if det.score else 0.0
                faces.append({"x": round(fx, 1), "y": round(fy, 1), "w": round(fw, 1), "h": round(fh, 1), "score": round(score, 3)})
                cx = fx + fw / 2
                face_centers_x.append(cx)
                frame_face_centers.append(cx)
                faces_total += 1
                if stripe_x0 <= cx <= stripe_x1:
                    centered += 1
            # M8.6 — multi-subject detection. If this frame has ≥2 faces separated by at least
            # width/4, we have an interaction shot that center-crop would slice. If one face is in
            # the left outer third AND another in the right outer third, it's definitely opposite
            # — a two-way conversation or confrontation where both must stay visible.
            if len(frame_face_centers) >= 2:
                left = min(frame_face_centers)
                right = max(frame_face_centers)
                if right - left >= width / 4:
                    multi_face_frames += 1
                if left < width / 3 and right > 2 * width / 3:
                    opposite_third_frames += 1
        print(json.dumps({"t": round(t, 2), "w": width, "h": height, "faces": faces}), flush=True)
        frame_idx += 1

    cap.release()

    centered_ratio = (centered / faces_total) if faces_total else 0.0
    mean_x = (sum(face_centers_x) / len(face_centers_x) / width) if face_centers_x else 0.0
    var_x = (sum(((c / width) - mean_x) ** 2 for c in face_centers_x) / len(face_centers_x)) if face_centers_x else 0.0
    std_x = var_x ** 0.5
    # M9.1 — median x (robust to outliers) + where that falls as a fraction of width. Used by
    # crop-safety.ts to decide whether to SHIFT the crop stripe to the subject rather than
    # falling back to blurred-bg. A face at median_x_norm=0.3 means a center-crop misses them
    # by 20% of the frame width.
    sorted_x = sorted(face_centers_x)
    median_x_norm = (sorted_x[len(sorted_x) // 2] / width) if sorted_x else 0.5
    print(json.dumps({
        "summary": True,
        "src_fps": round(src_fps, 2),
        "samples": samples,
        "frames_with_face": frames_with_face,
        "faces_total": faces_total,
        "face_center_x_mean_norm": round(mean_x, 3),
        "face_center_x_median_norm": round(median_x_norm, 3),
        "face_center_x_std_norm": round(std_x, 3),
        "centered_ratio": round(centered_ratio, 3),
        "multi_face_frames": multi_face_frames,
        "opposite_third_frames": opposite_third_frames,
        "multi_face_ratio": round(multi_face_frames / samples, 3) if samples else 0.0,
        "opposite_third_ratio": round(opposite_third_frames / samples, 3) if samples else 0.0,
        "width": width, "height": height,
    }), flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
