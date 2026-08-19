import { memo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { languageDirection } from "@/lib/languages";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Autocomplete } from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
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

export interface SpeakerNameOption {
  value: string;
  label: string;
  hint?: string;
}

/** Everything renaming a speaker needs, bundled so the memoized turns get
 *  one stable prop. `arm` starts the option queries on first open. */
export interface SpeakerRename {
  commit: (label: string, name: string) => Promise<unknown>;
  getOptions: (label: string) => SpeakerNameOption[];
  arm: () => void;
}

/**
 * Click-to-rename on a turn's speaker label: a popover holding an
 * autocomplete of the available names — the AI's suggested identity for
 * this voice, names already assigned in this recording, and the user's
 * speaker library. Free text is equally valid; the options suggest, they
 * never constrain.
 */
function SpeakerNameEditor({
  machineLabel,
  name,
  colorClass,
  rename,
}: {
  machineLabel: string;
  name: string;
  colorClass: string | undefined;
  rename: SpeakerRename;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  // Enter can select an option and submit in the same keystroke — the ref
  // sees the just-selected value where the closure would see the old one.
  const draftRef = useRef("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setDraftBoth = (next: string) => {
    draftRef.current = next;
    setDraft(next);
  };

  const options = open ? rename.getOptions(machineLabel) : [];

  const commit = async () => {
    const next = draftRef.current.trim().replace(/\s+/g, " ");
    if (saving) return;
    if (!next || next === name) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await rename.commit(machineLabel, next);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          rename.arm();
          setDraftBoth(name === machineLabel ? "" : name);
          setError(null);
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger
        title={`Rename ${name}`}
        aria-label={`Rename ${name}`}
        className={cn(
          "rounded px-0.5 text-left hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "data-[popup-open]:bg-accent"
        )}
      >
        <span
          className={cn("text-sm font-semibold", colorClass)}
          title={name === machineLabel ? undefined : machineLabel}
        >
          {name}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2">
          <Autocomplete
            value={draft}
            onValueChange={setDraftBoth}
            items={options}
            placeholder="Name this speaker…"
            aria-label={`Name for ${machineLabel}`}
            onSubmit={() => void commit()}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={saving || !draft.trim()}
              onClick={() => void commit()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One segment's words as an inline span — the unit selection and karaoke
 * anchor to (`data-seg`/`data-word`), kept memoized so a timeupdate tick
 * re-renders only the segment the playhead is in.
 */
const SegmentWords = memo(function SegmentWords({
  segment: seg,
  index,
  isActive,
  activeWordIndex,
  showTranslation,
  highlights,
  searchWords,
  onSeek,
  onFixWord,
  activeWordRef,
}: {
  segment: TurnSegment;
  index: number;
  isActive: boolean;
  activeWordIndex: number;
  showTranslation: boolean;
  highlights?: TurnHighlight[];
  searchWords?: Set<number>;
  onSeek: (time: number) => void;
  /** Double-click on a word: open the transcript-correction editor on it. */
  onFixWord?: (segIndex: number, wordIndex: number, rect: DOMRect) => void;
  activeWordRef: (el: HTMLSpanElement | null) => void;
}) {
  return (
    <span data-seg={index} className={cn(isActive && "bg-accent/40 rounded")}>
      {showTranslation && seg.translatedText ? (
        `${seg.translatedText} `
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
              // Several gestures share this span — click seeks, drag
              // selects, double-click edits. The editor's opener clears the
              // browser's double-click selection and any pending offer, so
              // the layers don't stack.
              onDoubleClick={
                onFixWord
                  ? (e) =>
                      onFixWord(index, wi, e.currentTarget.getBoundingClientRect())
                  : undefined
              }
              // No horizontal padding: span padding is not painted by the
              // native selection, so padded words made a drag-selection
              // read as separate boxes instead of one continuous run.
              className={cn(
                "cursor-pointer rounded hover:bg-primary/15",
                // Same blue the PDF search overlay paints its matches with.
                searchWords?.has(wi) && "bg-blue-400/35",
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
        `${seg.text} `
      )}
    </span>
  );
});

/**
 * One speaker turn: a run of consecutive segments by the same (display)
 * speaker, rendered as a single header and ONE flowing paragraph — merged
 * segments continue inline with no line break. Memoized; the per-tick
 * churn is isolated further inside SegmentWords.
 */
export const TranscriptTurn = memo(function TranscriptTurn({
  segments,
  startIndex,
  speakerName,
  colorClass,
  activeInRun,
  showTranslation,
  highlights,
  searchWords,
  rename,
  onMergeUp,
  onFixWord,
  onSeek,
  activeWordRef,
}: {
  /** The run's segments, in order. */
  segments: TurnSegment[];
  /** Global index of the run's first segment. */
  startIndex: number;
  speakerName: string;
  colorClass: string | undefined;
  /** Playhead position when it is inside this run (run-relative segment),
   *  null otherwise — null is stable, so only the active run re-renders
   *  per tick. */
  activeInRun: { segment: number; word: number } | null;
  showTranslation: boolean;
  /** Run-relative per-segment annotation highlights. */
  highlights?: (TurnHighlight[] | undefined)[];
  /** Run-relative per-segment search-matched word indices. */
  searchWords?: (Set<number> | undefined)[];
  /** Rename this run's diarizer label — the header becomes click-to-edit,
   *  offering the available names. Renaming to a neighbor's name merges
   *  the runs. */
  rename?: SpeakerRename;
  /** Remove this run's speaker label, folding it into the speaker above.
   *  Stable across renders (keyed by `startIndex`) so the memo holds; the
   *  first run renders no × — there is nothing above to merge into. */
  onMergeUp?: (startIndex: number) => void;
  /** Double-click a word to correct it (see SegmentWords). */
  onFixWord?: (segIndex: number, wordIndex: number, rect: DOMRect) => void;
  onSeek: (time: number) => void;
  activeWordRef: (el: HTMLSpanElement | null) => void;
}) {
  const first = segments[0];
  return (
    <div className={cn(startIndex > 0 && "mt-5")}>
      <div className="group/turnheader flex items-baseline gap-2 mb-1">
        {rename ? (
          <SpeakerNameEditor
            machineLabel={first.speaker}
            name={speakerName}
            colorClass={colorClass}
            rename={rename}
          />
        ) : (
          <span
            className={cn("text-sm font-semibold", colorClass)}
            title={speakerName === first.speaker ? undefined : first.speaker}
          >
            {speakerName}
          </span>
        )}
        <button
          onClick={() => onSeek(first.startTime)}
          className="text-xs text-muted-foreground tabular-nums hover:text-foreground hover:underline"
          title="Jump to this segment"
        >
          {formatTime(first.startTime)}
        </button>
        {onMergeUp && startIndex > 0 && (
          <button
            type="button"
            onClick={() => onMergeUp(startIndex)}
            title="Remove this speaker label (the turn joins the speaker above)"
            aria-label="Remove this speaker label and merge with the speaker above"
            className={cn(
              "grid size-4 place-items-center self-center rounded",
              "text-muted-foreground opacity-0 transition-opacity",
              "hover:bg-accent hover:text-foreground",
              "group-hover/turnheader:opacity-100 focus-visible:opacity-100",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        )}
      </div>
      <p
        dir={
          showTranslation
            ? languageDirection(first.translatedLanguageCode)
            : "ltr"
        }
        className="text-sm leading-6"
      >
        {segments.map((seg, rel) => (
          <SegmentWords
            key={seg._id}
            segment={seg}
            index={startIndex + rel}
            isActive={activeInRun?.segment === rel}
            activeWordIndex={
              activeInRun?.segment === rel ? activeInRun.word : -1
            }
            showTranslation={showTranslation}
            highlights={highlights?.[rel]}
            searchWords={searchWords?.[rel]}
            onSeek={onSeek}
            onFixWord={onFixWord}
            activeWordRef={activeWordRef}
          />
        ))}
      </p>
    </div>
  );
});
