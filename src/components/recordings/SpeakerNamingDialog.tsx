import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Sparkles } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Autocomplete } from "@/components/ui/autocomplete";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatTime } from "./speakerColors";

interface SpeakerRowData {
  label: string;
  colorClass: string | undefined;
  turnCount: number;
  totalSeconds: number;
  samples: string[];
}

/**
 * Who is who in this recording. One row per diarized label, in
 * first-appearance order: the speaker's color chip, their longest sample
 * utterances (identification beats statistics), a name input backed by the
 * user-wide speaker library, and — when Analyze has read a name out of the
 * transcript ("Thanks, Dr. Kessler") — a suggestion chip with its verbatim
 * evidence, appearing reactively if analysis finishes while the dialog is
 * open. Partial answers are fine; Skip stops the asking without naming
 * anyone. Names never overwrite the diarizer's labels anywhere below the
 * UI — the label stays the machine key.
 */
export function SpeakerNamingDialog({
  document: doc,
  segments,
  speakerColor,
  speakerRows,
  open,
  onOpenChange,
}: {
  document: Doc<"documents">;
  segments: {
    speaker: string;
    startTime: number;
    endTime: number;
    text: string;
  }[];
  speakerColor: Map<string, string>;
  speakerRows: Doc<"documentSpeakers">[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const confirm = useMutation(api.documentSpeakers.confirm);
  const library = useQuery(api.speakers.list, open ? {} : "skip");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const rows = useMemo<SpeakerRowData[]>(() => {
    const byLabel = new Map<string, SpeakerRowData>();
    for (const seg of segments) {
      let row = byLabel.get(seg.speaker);
      if (!row) {
        row = {
          label: seg.speaker,
          colorClass: speakerColor.get(seg.speaker),
          turnCount: 0,
          totalSeconds: 0,
          samples: [],
        };
        byLabel.set(seg.speaker, row);
      }
      row.turnCount += 1;
      row.totalSeconds += Math.max(0, seg.endTime - seg.startTime);
    }
    // Two longest utterances per speaker — the lines most likely to say who
    // is talking.
    for (const row of byLabel.values()) {
      row.samples = segments
        .filter((seg) => seg.speaker === row.label)
        .sort((a, b) => b.text.length - a.text.length)
        .slice(0, 2)
        .map((seg) => seg.text);
    }
    return [...byLabel.values()];
  }, [segments, speakerColor]);

  const savedByLabel = useMemo(() => {
    const map = new Map<string, Doc<"documentSpeakers">>();
    for (const row of speakerRows ?? []) map.set(row.label, row);
    return map;
  }, [speakerRows]);

  const items = useMemo(
    () =>
      (library ?? []).map((speaker) => ({
        value: speaker.name,
        label: speaker.name,
        hint: `used ${speaker.useCount}×`,
      })),
    [library]
  );

  function draftFor(label: string): string {
    if (label in drafts) return drafts[label];
    const saved = savedByLabel.get(label);
    return saved?.source === "human" ? saved.name : "";
  }

  async function submit(skipped: boolean) {
    if (saving) return;
    setSaving(true);
    try {
      await confirm({
        documentId: doc._id,
        assignments: skipped
          ? []
          : rows
              .map((row) => ({ label: row.label, name: draftFor(row.label) }))
              .filter((a) => a.name.trim()),
        skipped,
      });
      onOpenChange(false);
      setDrafts({});
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Any close — Skip, Escape, outside click — records the answer so
        // the dialog doesn't re-nag on the next visit.
        if (!next) void submit(true);
        else onOpenChange(true);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogTitle>Who's speaking?</DialogTitle>
        <DialogDescription>
          Names show in the transcript and link each voice to your project's
          entities. Leave anyone blank to keep their label.
        </DialogDescription>
        <div className="mt-3 flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          {rows.map((row) => {
            const suggestion = savedByLabel.get(row.label);
            const showSuggestion =
              suggestion?.source === "ai" &&
              suggestion.name &&
              draftFor(row.label) !== suggestion.name;
            return (
              <div key={row.label} className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2">
                  <span className={cn("text-sm font-semibold", row.colorClass)}>
                    {row.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatTime(row.totalSeconds)} · {row.turnCount} turn
                    {row.turnCount !== 1 && "s"}
                  </span>
                </div>
                {row.samples.map((sample, i) => (
                  <p
                    key={i}
                    className="line-clamp-2 text-xs text-muted-foreground"
                  >
                    “{sample}”
                  </p>
                ))}
                <Autocomplete
                  value={draftFor(row.label)}
                  onValueChange={(next) =>
                    setDrafts((prev) => ({ ...prev, [row.label]: next }))
                  }
                  items={items}
                  placeholder="Name this speaker…"
                  aria-label={`Name for ${row.label}`}
                />
                {showSuggestion && (
                  <button
                    type="button"
                    onClick={() =>
                      setDrafts((prev) => ({
                        ...prev,
                        [row.label]: suggestion.name,
                      }))
                    }
                    className="inline-flex max-w-full items-center gap-1.5 self-start rounded-full border bg-card px-2 py-0.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={suggestion.evidence}
                  >
                    <Sparkles className="size-3 shrink-0 text-primary" />
                    <span className="font-medium">{suggestion.name}</span>
                    {suggestion.evidence && (
                      <span className="min-w-0 truncate text-muted-foreground">
                        — “{suggestion.evidence}”
                      </span>
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => void submit(true)}
          >
            Skip
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void submit(false)}>
            {saving ? "Saving…" : "Save names"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type { Id };
