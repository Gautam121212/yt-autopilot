/**
 * Clipper M2 — assemble. Produces the final deliverable(s):
 *
 *   LONG format: concatenate chosen clips into one 7-15 min mp4. Each join uses a 400ms xfade on
 *   video + afade on audio so the cut doesn't sound like a splice. Horizontal 16:9 preserved.
 *
 *   SHORTS format: each chosen clip becomes its own 9:16 1080×1920 mp4, center-cropped from the
 *   source frame. No concatenation. The caller writes N files.
 *
 * Both paths re-encode once because the loudnorm pass earlier already changed the audio and the
 * crop/pad for vertical changes the video, so a stream-copy wouldn't apply.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type AttributionOpts = { channel: string; title: string };

/** Escape a user-supplied string for ffmpeg's drawtext filter (colons, backslashes, commas, single
 *  quotes all need special treatment). Returns a bare string, caller wraps in single quotes.
 *  M6: cap at `maxChars` because the title bar is drawn with x=(w-text_w)/2 — if text is wider
 *  than the frame (1080px) it starts at a negative x and overflows both edges. At fontsize=36
 *  roughly 32 ascii chars fit; we take 30 to be safe and append "…" if we truncated. */
function escDrawtext(s: string, maxChars = 100): string {
  let text = s;
  if (text.length > maxChars) text = text.slice(0, maxChars - 1).trimEnd() + "…";
  // M13.1 — ffmpeg filtergraph parsing of drawtext text with ESCAPED colons/commas was wedging
  // on titles like "BREAKING: New Canada-U.S. Trade Deal..." in trial #7: the escape sequence
  // `\\:` is correct per docs but the chain parser downstream choked. Sidestep the whole mess
  // by substituting visually-identical Unicode variants that are NOT filtergraph specials.
  //   :  →  ꞉ (U+A789 Modifier Letter Colon)
  //   ,  →  ‚ (U+201A Single Low-9 Quotation Mark — reads like a tiny comma)
  //   %  →  ％ (U+FF05 Fullwidth Percent Sign)
  //   '  →  ’ (U+2019 Right Single Quotation Mark)
  //   \  →  dropped (never a legitimate user glyph in a title)
  return text
    .replace(/\\/g, "")
    .replace(/:/g, "꞉")
    .replace(/,/g, "‚")
    .replace(/%/g, "％")
    .replace(/'/g, "’");
}

/** M6 — layout decision passed down from crop-safety:
 *  - "center-crop": destructive, 9:16 stripe at the frame center. Best when subject is centered.
 *  - "shifted-crop" (M9.1): same as center-crop but the stripe is shifted so a subject whose
 *    median x is off-center but STABLE stays visible. Caller passes cropCenterXNorm (0..1).
 *  - "blurred-bg": non-destructive letterbox-on-blurred-background. Used when crop would slice
 *    a subject (face off-stripe + unstable, or multi-subject at opposite thirds). */
export type ShortLayout = "center-crop" | "shifted-crop" | "blurred-bg";

/** M7.4 — optional caption burn-in. SRT path from whisper_captions.py. Captions are placed at
 *  y=h*0.62 (lower-third) so they don't cover faces (which typically sit in the upper two-thirds
 *  of a 9:16 crop) and don't overlap the attribution bar at the very bottom. */
export type CaptionOpts = { srtPath: string };

/** Build one 1080×1920 vertical short from a 16:9 source. By default center-crops to 9:16; pass
 *  layout="blurred-bg" when crop-safety said the subject would be sliced — the full landscape
 *  frame is scaled to fit inside the vertical canvas, with a large blurred copy filling the
 *  letterbox area so the clip reads as a native vertical. If `attr` is provided, burns in a
 *  channel + original-title attribution for the first 3 seconds. If `captions` is provided,
 *  burns in SRT subtitles at the lower-third throughout. */
export async function makeShort(
  inputPath: string, outDir: string, label: string,
  attr?: AttributionOpts, layout: ShortLayout = "center-crop",
  captions?: CaptionOpts,
  cropCenterXNorm = 0.5,
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const output = path.join(outDir, `short_${label}.mp4`);

  let vf: string;
  if (layout === "blurred-bg") {
    // Build a 1080×1920 canvas from TWO copies of the source:
    //   • BG: scaled to COVER the full 1080×1920, heavily blurred, slightly dimmed → fills the
    //     letterbox area so there are no black bars.
    //   • FG: scaled to FIT entirely within 1080×1920 (letterbox), overlaid centered.
    // The split allocates frames to both branches, scales each, pads/overlays, and returns one
    // 1080×1920 stream.
    //
    // Two-copy construction uses split=2 then scales each copy with force_original_aspect_ratio
    // (increase for the bg, decrease for the fg). The result preserves the full composition the
    // original creator shot — nothing is sliced off.
    vf = [
      "split=2[bg][fg]",
      "[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=min(h\\,w)/20:luma_power=2:chroma_radius=min(cw\\,ch)/20:chroma_power=2,eq=brightness=-0.08[bgb]",
      "[fg]scale=1080:1920:force_original_aspect_ratio=decrease[fgs]",
      "[bgb][fgs]overlay=(W-w)/2:(H-h)/2",
    ].join(";");
  } else if (layout === "shifted-crop") {
    // M9.1 — shifted crop. The 9:16 stripe is width=ih*9/16, placed so its CENTER sits at
    // cropCenterXNorm * iw. Clamp to [0, iw-stripeWidth] so the stripe never falls off the frame.
    //   stripeWidth = ih*9/16
    //   centerX     = iw * cropCenterXNorm
    //   x           = clamp(centerX - stripeWidth/2, 0, iw - stripeWidth)
    // We pass the ffmpeg expression directly so it's evaluated against this clip's actual iw/ih.
    const cx = cropCenterXNorm.toFixed(3);
    vf = `crop=ih*9/16:ih:max(0\\,min(iw-ih*9/16\\,iw*${cx}-ih*9/32)):0,scale=1080:1920:flags=lanczos`;
  } else {
    vf = "crop=ih*9/16:ih,scale=1080:1920:flags=lanczos";
  }

  if (attr) {
    // 3s overlay at the bottom: dark semi-transparent bar + two lines of text.
    // Font: use whatever ffmpeg can find on the runner (ubuntu: DejaVu). No bundled font because
    // most ffmpeg builds have one on PATH; fallback: fontfile=default lets ffmpeg pick.
    // Channel handle: at fontsize=52 roughly 22 chars fit the 1080 frame; truncate at 20.
    // Title: at fontsize=36 roughly 32 chars fit; truncate at 30 so the drawtext overlay doesn't
    // run off both sides of the frame (see M6 demo bug — "@The Chateau Diaries — 000 for
    // PLYWOOD?! Somehow It Is Cheaper to Use Solid Oak" overflowed left and right at 100 chars).
    const channel = escDrawtext("@" + attr.channel, 20);
    const title = escDrawtext(attr.title, 30);
    // Both layouts share the same bottom-bar; blurred-bg uses filter_complex-style chain so we
    // append with commas (the filter chain inside filter_complex is a graph, not a vf; convert
    // by passing it through filter_complex).
    const chainTail =
      `,drawbox=y=ih-220:w=iw:h=220:color=black@0.55:t=fill:enable='lt(t,3)'` +
      `,drawtext=text='${channel}':fontcolor=white:fontsize=52:x=(w-text_w)/2:y=h-170:enable='lt(t,3)'` +
      `,drawtext=text='${title}':fontcolor=white@0.85:fontsize=36:x=(w-text_w)/2:y=h-100:enable='lt(t,3)'`;
    if (layout === "blurred-bg") {
      vf = vf + chainTail;
    } else {
      vf = vf + chainTail;
    }
  }

  // M7.4: append SRT subtitles filter if captions provided. We burn in on the OUTPUT canvas
  // (post-crop/scale) so font sizing is correct for 1080x1920. Style:
  //   - Lower-third anchor (Alignment=2, MarginV=360px up from bottom)
  //   - Readable: 56pt bold, white text, semi-opaque black outline + box
  //   - DejaVu Sans (installed in CI via fonts-dejavu-core)
  // The subtitles filter escape: : must become \: and ' must be dropped from path.
  if (captions?.srtPath) {
    // M10.2 — libass font lookup. Run #2 shipped captioned clips with EMPTY lower-third because
    // `FontName=DejaVu Sans` fell back silently (fc-cache not refreshed after apt-install on CI).
    // Fix: pass fontsdir pointing at the DejaVu TTF directory so libass loads the font directly
    // without touching fontconfig. Also raise FontSize because 22pt was too small for a 1080-wide
    // frame — bumping to 42pt (ASS point-size, roughly equivalent to 56-62 pixels at this scale).
    const srtEsc = captions.srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "");
    const style =
      "FontName=DejaVu Sans,FontSize=42,Bold=1," +
      "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&HAA000000," +
      "BorderStyle=1,Outline=4,Shadow=0," +
      "Alignment=2,MarginV=360";
    // fontsdir points at the dir where DejaVu is installed by `fonts-dejavu-core` on Ubuntu.
    vf = vf + `,subtitles='${srtEsc}':fontsdir=/usr/share/fonts/truetype/dejavu:force_style='${style}'`;
  }

  // For blurred-bg we use -filter_complex because the graph has multiple branches; for
  // center-crop a simple -vf is fine.
  const useComplex = layout === "blurred-bg";
  const filterArgs = useComplex ? ["-filter_complex", vf] : ["-vf", vf];

  await exec("ffmpeg", [
    "-y", "-v", "error",
    "-i", inputPath,
    ...filterArgs,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-ar", "48000", "-b:a", "160k",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    output,
  ], { maxBuffer: 32 * 1024 * 1024 });
  return output;
}

/** M12.1 — attribution + captions filter string for the LONG (16:9) format. Font sizes are
 *  roughly 1.4× the shorts sizes because the output is 1920×1080 instead of 1080×1920 and the
 *  reader is further from the screen. The attribution bar sits at the TOP of a 16:9 frame
 *  (shorts put it at bottom; long videos look better with top credit so the player's control
 *  overlay doesn't hide it). */
function longOverlayChain(attr?: AttributionOpts, srtPath?: string): string {
  let tail = "";
  if (attr) {
    const channel = escDrawtext("@" + attr.channel, 24);
    const title = escDrawtext(attr.title, 40);
    tail +=
      `,drawbox=y=0:w=iw:h=150:color=black@0.55:t=fill:enable='lt(t,3)'` +
      `,drawtext=text='${channel}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=20:enable='lt(t,3)'` +
      `,drawtext=text='${title}':fontcolor=white@0.85:fontsize=34:x=(w-text_w)/2:y=78:enable='lt(t,3)'`;
  }
  if (srtPath) {
    const srtEsc = srtPath.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "");
    // Lower-third anchor, MarginV smaller than shorts because 1080 vertical space < 1920.
    const style =
      "FontName=DejaVu Sans,FontSize=28,Bold=1," +
      "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&HAA000000," +
      "BorderStyle=1,Outline=3,Shadow=0," +
      "Alignment=2,MarginV=90";
    tail += `,subtitles='${srtEsc}':fontsdir=/usr/share/fonts/truetype/dejavu:force_style='${style}'`;
  }
  return tail;
}

/** Concatenate clips with 400ms xfade + afade transitions into one long-form 16:9 mp4. The source
 *  clips should all be the same resolution/fps (they are — our extract step encoded them
 *  uniformly). M12.1 — now also accepts attribution + captions, applied as a trailing filter
 *  chain on the final video output. */
export async function concatLong(
  clipPaths: string[], outDir: string, label = "long",
  attr?: AttributionOpts, captions?: CaptionOpts,
): Promise<string> {
  if (clipPaths.length === 0) throw new Error("concatLong: no clips");
  await mkdir(outDir, { recursive: true });
  const output = path.join(outDir, `long_${label}.mp4`);
  const overlayTail = longOverlayChain(attr, captions?.srtPath);

  // Trivial case: one clip → re-mux with the overlay chain applied.
  if (clipPaths.length === 1) {
    const vfBase = "null";          // no transform; the overlay chain adds the overlays
    const vf = overlayTail ? `${vfBase}${overlayTail}` : vfBase;
    await exec("ffmpeg", [
      "-y", "-v", "error", "-i", clipPaths[0]!,
      "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-ar", "48000", "-b:a", "160k",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      output,
    ], { maxBuffer: 32 * 1024 * 1024 });
    return output;
  }

  // Multi-clip: build an xfade chain. For N clips we need N-1 xfade transitions. Each xfade
  // needs the OFFSET into the current stream where the fade begins (previous-length - overlap).
  // We query each clip's duration via ffprobe and build the filtergraph.
  const durs: number[] = [];
  for (const c of clipPaths) {
    const r = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", c]);
    durs.push(parseFloat(r.stdout.trim()));
  }
  const overlap = 0.4;
  const parts: string[] = [];
  const inputs: string[] = [];
  clipPaths.forEach((c) => { inputs.push("-i", c); });

  // Build video chain: v0 xfade v1 → vxf1, vxf1 xfade v2 → vxf2, ...
  let vLabel = "0:v";
  let aLabel = "0:a";
  let runningSec = 0;
  for (let i = 1; i < clipPaths.length; i++) {
    const prevDur = i === 1 ? durs[0]! : (runningSec + durs[i - 1]! - overlap);
    runningSec = i === 1 ? durs[0]! - overlap : (prevDur);
    const offset = i === 1 ? durs[0]! - overlap : runningSec;
    parts.push(`[${vLabel}][${i}:v]xfade=transition=fade:duration=${overlap}:offset=${offset.toFixed(3)}[vx${i}]`);
    parts.push(`[${aLabel}][${i}:a]acrossfade=d=${overlap}[ax${i}]`);
    vLabel = `vx${i}`;
    aLabel = `ax${i}`;
  }
  // M12.1 — apply overlays as a final filter after the xfade chain.
  const finalVLabel = overlayTail ? "vout" : vLabel;
  if (overlayTail) {
    parts.push(`[${vLabel}]${overlayTail.slice(1) /* drop leading comma */}[vout]`);
  }

  await exec("ffmpeg", [
    "-y", "-v", "error",
    ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", `[${finalVLabel}]`, "-map", `[${aLabel}]`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-c:a", "aac", "-ar", "48000", "-b:a", "160k",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    output,
  ], { maxBuffer: 64 * 1024 * 1024 });
  return output;
}

/** Write a plain-text manifest alongside the outputs so a future upload step can read the picks. */
export async function writeManifest(outDir: string, data: unknown): Promise<string> {
  const p = path.join(outDir, "manifest.json");
  await writeFile(p, JSON.stringify(data, null, 2));
  return p;
}
