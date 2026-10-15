import React from "react";
import { AbsoluteFill, Img } from "remotion";
import { resolveAsset } from "./lib/resolveAsset";

/**
 * YouTube thumbnail composition. Rendered with `npx remotion still` (one frame → PNG/JPG)
 * instead of `render` so we don't pay for a full video pipeline on a static image.
 *
 * Design is a yt-autopilot patch, not from OpenMontage upstream. Mirrors the Apple-design
 * principles the CaptionOverlay and HeroTitle components already use:
 *
 * - Translucent material scrim at the bottom (backdrop-filter blur + saturate), not a flat
 *   drawbox. Gives the text a glass surface that reads over any photo.
 * - Size-specific tracking: display-sized text wants NEGATIVE letter-spacing per the Apple
 *   type rules ("tighten large text, body near 0"). At 140px we tighten -0.025em.
 * - Weight + size hierarchy, not just color: line1 is 700, line2 is 900. Yellow accent on
 *   line2 is the punchline reveal — same visual logic as the HeroTitle component.
 * - Inset top-edge highlight on the material layer so it reads as a lit surface, not a flat
 *   rectangle. The detail Apple uses to make glass feel physical rather than painted-on.
 * - Vignette darkens the corners so the type pops in thumbnail-grid sizes where viewers
 *   decide whether to click in under a second.
 */
export type ThumbnailProps = {
  /** Background image path. Absolute POSIX paths get file:// via resolveAsset. */
  bgSrc: string;
  /** First caption line (white). */
  line1: string;
  /** Second caption line (yellow accent). Omit for a single-line thumbnail. */
  line2?: string;
  /** Accent color for line2. Default matches the ffmpeg path's #FFC83D. */
  accentColor?: string;
};

const DEFAULT_ACCENT = "#FFC83D";

export const Thumbnail: React.FC<ThumbnailProps> = ({ bgSrc, line1, line2, accentColor = DEFAULT_ACCENT }) => {
  const longest = Math.max(line1.length, line2?.length ?? 1);
  // Apple-design tracking: display sizes want negative letter-spacing. Scale the base size by
  // the longest line so a 20-char headline doesn't overflow the safe area.
  const USABLE_PX = 1280 - 100; // 50px side margins
  const EM = 0.56; // measured width of a bold cap in Inter/Space Grotesk at scale
  const line1Size = Math.max(64, Math.min(160, Math.round(USABLE_PX / (longest * EM))));
  const line2Size = line1Size;
  const tracking = line1Size >= 100 ? "-0.025em" : line1Size >= 70 ? "-0.015em" : "0";

  return (
    <AbsoluteFill style={{ backgroundColor: "#0F172A" }}>
      <AbsoluteFill>
        <Img src={resolveAsset(bgSrc)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
      {/* Vignette — darkens corners so the text block pops in a thumbnail grid. */}
      <AbsoluteFill
        style={{
          background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,0.55) 100%)",
          pointerEvents: "none",
        }}
      />
      {/* Translucent material scrim: glass bottom third, not a hard rectangle. */}
      <AbsoluteFill style={{ justifyContent: "flex-end" }}>
        <div
          style={{
            padding: line2 ? "36px 50px 44px" : "28px 50px 36px",
            background: "linear-gradient(to top, rgba(10,15,30,0.72) 60%, rgba(10,15,30,0) 100%)",
            backdropFilter: "blur(14px) saturate(160%)",
            WebkitBackdropFilter: "blur(14px) saturate(160%)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.14)",
          }}
        >
          <div
            style={{
              fontFamily: "Inter, 'Space Grotesk', system-ui, sans-serif",
              color: "white",
              fontWeight: 800,
              fontSize: line1Size,
              lineHeight: 1.02,
              letterSpacing: tracking,
              textShadow: "0 2px 10px rgba(0,0,0,0.5)",
              textTransform: "uppercase",
            }}
          >
            {line1}
          </div>
          {line2 ? (
            <div
              style={{
                marginTop: Math.round(line1Size * 0.08),
                fontFamily: "Inter, 'Space Grotesk', system-ui, sans-serif",
                color: accentColor,
                fontWeight: 900,
                fontSize: line2Size,
                lineHeight: 1.02,
                letterSpacing: tracking,
                textShadow: "0 2px 10px rgba(0,0,0,0.55)",
                textTransform: "uppercase",
              }}
            >
              {line2}
            </div>
          ) : null}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
