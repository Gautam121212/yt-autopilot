import React, { Fragment } from "react";
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

// Word-level caption for TikTok-style highlight display
export interface WordCaption {
  word: string;
  startMs: number;
  endMs: number;
  // Force a page break after this word (e.g. sentence or scene boundaries).
  // Useful for CJK captions where pages should align with clause boundaries.
  pageBreakAfter?: boolean;
}

type CaptionOverlayProps = {
  words: WordCaption[];
  // How many words to show at once in a "page"
  wordsPerPage?: number;
  fontSize?: number;
  color?: string;
  highlightColor?: string;
  backgroundColor?: string;
  fontFamily?: string;
  // Separator rendered between words. Space-delimited languages want the
  // default " "; CJK languages (no inter-word spacing) should pass "".
  wordSeparator?: string;
};

interface CaptionPage {
  words: WordCaption[];
  startMs: number;
  endMs: number;
}

function buildPages(words: WordCaption[], wordsPerPage: number): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let pageWords: WordCaption[] = [];
  const flush = () => {
    if (pageWords.length === 0) return;
    pages.push({
      words: pageWords,
      startMs: pageWords[0].startMs,
      endMs: pageWords[pageWords.length - 1].endMs,
    });
    pageWords = [];
  };
  for (const w of words) {
    pageWords.push(w);
    if (pageWords.length >= wordsPerPage || w.pageBreakAfter) flush();
  }
  flush();
  return pages;
}

const PageRenderer: React.FC<{
  page: CaptionPage;
  fontSize: number;
  color: string;
  highlightColor: string;
  backgroundColor: string;
  fontFamily: string;
  wordSeparator: string;
}> = ({ page, fontSize, color, highlightColor, backgroundColor, fontFamily, wordSeparator }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const currentMs = page.startMs + (frame / fps) * 1000;

  // Spring entrance.
  // Apple-design (yt-autopilot vendored patch): calmer, closer to critically damped. A caption
  // appearing isn't a momentum interaction (no flick preceded it), so overshoot reads as "cute"
  // rather than physical. Keeping `stiffness` moderate so the entrance doesn't drag.
  const entrance = spring({
    frame,
    fps,
    config: { damping: 24, stiffness: 160, mass: 0.9 },
  });

  // Tracking (letter-spacing) is size-specific per the Apple-design type rules:
  // at 42px (default caption) we're in the "slightly tighten" range; at 60px+ definitely negative.
  // Formula is approximate — the skill's rule is "tighten large text, leave body near 0".
  const tracking = fontSize >= 60 ? "-0.02em" : fontSize >= 36 ? "-0.005em" : "0.01em";

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 80,
      }}
    >
      <div
        style={{
          opacity: entrance,
          transform: `translateY(${interpolate(entrance, [0, 1], [20, 0])}px)`,
          backgroundColor,
          // Material layer: backdrop blur + saturation lift so the pill reads as glass over any
          // B-roll (Apple-design "materials convey hierarchy"). WebkitBackdropFilter for Safari/
          // Chromium parity; Remotion renders through Chrome so it's effectively always supported,
          // but the prefix costs nothing and future-proofs for Studio playback in other browsers.
          backdropFilter: "blur(20px) saturate(180%)",
          WebkitBackdropFilter: "blur(20px) saturate(180%)",
          borderRadius: 14,
          // Subtle top edge catches "light" — the hallmark detail of a translucent material. Gives
          // the pill definition without a hard border.
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.12), 0 8px 24px rgba(0,0,0,0.25)",
          padding: "14px 28px",
          maxWidth: "80%",
          textAlign: "center",
        }}
      >
        <span
          style={{
            fontSize,
            fontWeight: 700,
            fontFamily,
            lineHeight: 1.35,
            letterSpacing: tracking,
            whiteSpace: "pre-wrap",
          }}
        >
          {page.words.map((w, i) => {
            const isActive = w.startMs <= currentMs && w.endMs > currentMs;
            const isPast = w.endMs <= currentMs;
            return (
              <Fragment key={`${w.startMs}-${i}`}>
                <span
                  style={{
                    // Keep each word unbroken so lines wrap only at word
                    // boundaries. For space-delimited text this matches the
                    // previous behavior; for CJK it prevents mid-word breaks.
                    display: "inline-block",
                    whiteSpace: "nowrap",
                    color: isActive ? highlightColor : isPast ? color : `${color}99`,
                    transition: "none", // CSS transitions forbidden in Remotion
                    textShadow: isActive
                      ? `0 0 20px ${highlightColor}66, 0 2px 4px rgba(0,0,0,0.5)`
                      : "0 2px 4px rgba(0,0,0,0.5)",
                  }}
                >
                  {w.word}
                </span>
                {i < page.words.length - 1 ? wordSeparator : ""}
              </Fragment>
            );
          })}
        </span>
      </div>
    </AbsoluteFill>
  );
};

export const CaptionOverlay: React.FC<CaptionOverlayProps> = ({
  words,
  wordsPerPage = 6,
  fontSize = 42,
  color = "#F8FAFC",
  highlightColor = "#22D3EE",
  backgroundColor = "rgba(15, 23, 42, 0.75)",
  fontFamily = "Space Grotesk, Inter, system-ui, sans-serif",
  wordSeparator = " ",
}) => {
  const { fps } = useVideoConfig();
  const pages = buildPages(words, wordsPerPage);

  return (
    <AbsoluteFill>
      {pages.map((page, i) => {
        const fromFrame = Math.round((page.startMs / 1000) * fps);
        const nextStart = pages[i + 1]?.startMs ?? page.endMs + 500;
        const duration = Math.max(
          1,
          Math.round(((nextStart - page.startMs) / 1000) * fps)
        );

        return (
          <Sequence key={i} from={fromFrame} durationInFrames={duration}>
            <PageRenderer
              page={page}
              fontSize={fontSize}
              color={color}
              highlightColor={highlightColor}
              backgroundColor={backgroundColor}
              fontFamily={fontFamily}
              wordSeparator={wordSeparator}
            />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
