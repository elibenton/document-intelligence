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
  showHeader = true,
  searchWords,
  rename,
  onMergeUp,
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
  /** False when the previous turn is the same (display) speaker — the turns
   *  read as one, so the repeated name/time header is dropped. */
  showHeader?: boolean;
  /** Word indices covered by the active document search, if any. */
  searchWords?: Set<number>;
  /** Rename this turn's diarizer label — the header becomes click-to-edit,
   *  offering the available names (AI suggestion, this recording's names,
   *  the speaker library). Renaming to a neighbor's name merges the turns
   *  (see showHeader). */
  rename?: SpeakerRename;
  /** Remove this turn's speaker label, folding its run into the speaker
   *  above. Stable across renders (keyed by `index`) so the memo holds;
   *  the first turn renders no × — there is nothing above to merge into. */
  onMergeUp?: (index: number) => void;
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
    // Continuation turns (header hidden) hug the previous turn so a run of
    // same-speaker segments reads as one turn; the parent list has no gap of
    // its own.
    <div data-seg={index} className={cn(index > 0 && (showHeader ? "mt-5" : "mt-1"))}>
      {showHeader && (
        <div className="group/turnheader flex items-baseline gap-2 mb-1">
          {rename ? (
            <SpeakerNameEditor
              machineLabel={seg.speaker}
              name={speakerName}
              colorClass={colorClass}
              rename={rename}
            />
          ) : (
            <span
              className={cn("text-sm font-semibold", colorClass)}
              title={speakerName === seg.speaker ? undefined : seg.speaker}
            >
              {speakerName}
            </span>
          )}
          <button
            onClick={() => onSeek(seg.startTime)}
            className="text-xs text-muted-foreground tabular-nums hover:text-foreground hover:underline"
            title="Jump to this segment"
          >
            {formatTime(seg.startTime)}
          </button>
          {onMergeUp && index > 0 && (
            <button
              type="button"
              onClick={() => onMergeUp(index)}
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
      )}
      <p
        dir={showTranslation ? languageDirection(seg.translatedLanguageCode) : "ltr"}
        className={cn(
          "text-sm leading-6",
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
          seg.text
        )}
      </p>
    </div>
  );
});
