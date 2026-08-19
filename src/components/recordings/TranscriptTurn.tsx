import { memo } from "react";
import { cn } from "@/lib/utils";
import { languageDirection } from "@/lib/languages";
import { formatTime } from "./speakerColors";

export interface TurnHighlight {
  start: number;
  end: number;
  /** Translucent fill from annotationColors — composes with karaoke. */
  fill: string;
}

export interface TurnSegment {
  _id: string;
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
  translatedText?: string;
  translatedLanguageCode?: string;
  words: { word: string; start: number; end: number }[];
}

/**
 * One speaker turn, memoized so a timeupdate tick re-renders only the turn
 * the playhead left and the turn it entered — not the whole transcript.
 * Word keys are the start time, which survives future correction edits the
 * way an array index would not.
 */
export const TranscriptTurn = memo(function TranscriptTurn({
  segment: seg,
  index,
  speakerName,
  colorClass,
  isActive,
  activeWordIndex,
  showTranslation,
  highlights,
  onSeek,
  activeWordRef,
}: {
  segment: TurnSegment;
  index: number;
  speakerName: string;
  colorClass: string | undefined;
  isActive: boolean;
  activeWordIndex: number;
  showTranslation: boolean;
  /** Time-anchored highlights overlapping this turn; empty for most turns,
   *  which keeps the memo effective. */
  highlights?: TurnHighlight[];
  onSeek: (time: number) => void;
  activeWordRef: (el: HTMLSpanElement | null) => void;
}) {
  return (
    <div data-seg={index}>
      <div className="flex items-baseline gap-2 mb-1">
        <span
          className={cn("text-sm font-semibold", colorClass)}
          title={speakerName === seg.speaker ? undefined : seg.speaker}
        >
          {speakerName}
        </span>
        <button
          onClick={() => onSeek(seg.startTime)}
          className="text-xs text-muted-foreground tabular-nums hover:text-foreground hover:underline"
          title="Jump to this segment"
        >
          {formatTime(seg.startTime)}
        </button>
      </div>
      <p
        dir={showTranslation ? languageDirection(seg.translatedLanguageCode) : "ltr"}
        className={cn(
          "text-sm leading-7",
          isActive && "bg-accent/40 rounded px-1 -mx-1",
        )}
      >
        {showTranslation && seg.translatedText ? (
          seg.translatedText
        ) : seg.words.length > 0 ? (
          seg.words.map((w, wi) => {
            const wordActive = isActive && activeWordIndex === wi;
            const highlightOf = (word: { start: number; end: number } | undefined) =>
              word
                ? highlights?.find((h) => word.start < h.end && word.end > h.start)
                : undefined;
            const highlight = highlightOf(w);
            // A run of highlighted words paints as one continuous stripe: only
            // the run's outer edges keep their rounding, so the marker doesn't
            // scallop at every word boundary.
            const joinsPrev = highlight && Boolean(highlightOf(seg.words[wi - 1]));
            const joinsNext = highlight && Boolean(highlightOf(seg.words[wi + 1]));
            return (
              <span
                key={w.start}
                data-word={wi}
                ref={wordActive ? activeWordRef : undefined}
                onClick={() => onSeek(w.start)}
                className={cn(
                  "cursor-pointer rounded px-0.5 hover:bg-primary/15",
                  wordActive && "bg-primary/25",
                )}
                style={
                  highlight && !wordActive
                    ? {
                        backgroundColor: highlight.fill,
                        borderRadius: `${joinsPrev ? "0" : "0.25rem"} ${
                          joinsNext ? "0" : "0.25rem"
                        } ${joinsNext ? "0" : "0.25rem"} ${
                          joinsPrev ? "0" : "0.25rem"
                        }`,
                      }
                    : undefined
                }
                title={formatTime(w.start)}
              >
                {w.word}{" "}
              </span>
            );
          })
        ) : (
          seg.text
        )}
      </p>
    </div>
  );
});
