import { useState } from "react";
import type { ReactNode } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Inline editing, the shared way: the value itself is a popover trigger,
 * revealed as editable on hover/focus, saving on commit — Enter or an
 * outside-click dismissal while dirty — with Escape cancelling. One rule
 * everywhere (mirrors the schema's *Source contract): committing text stamps
 * the edit; committing empty clears the field and hands it back to the AI.
 *
 * Three primitives, one file, all riding ui/popover.tsx — no hand-rolled
 * focus management anywhere (the fence in CLAUDE.md exists because that's
 * how the last three dialogs decayed).
 *
 * Error handling is local: a rejected onCommit keeps the popup open and
 * renders the message under the field. There is deliberately no toast — the
 * user is looking at the field they just edited.
 */

const TRIGGER = (empty: boolean) =>
  cn(
    "group/edit inline-flex max-w-full items-center gap-1 rounded px-0.5 text-left",
    "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    "data-[popup-open]:bg-accent",
    empty && "text-muted-foreground italic"
  );

function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Convex prefixes server errors with a long call-site preamble; the part a
  // human can act on is the thrown message at the end.
  return raw.split("Uncaught Error:").pop()?.trim() || "Couldn't save.";
}

export function EditableText({
  value,
  placeholder = "—",
  label,
  multiline = false,
  onCommit,
  renderValue,
  allowEmpty = true,
  className,
}: {
  value: string | null | undefined;
  /** Rendered when the value is absent — the fillable slot. A node, so the
   *  library can keep its own styled "Unknown date". */
  placeholder?: ReactNode;
  /** Accessible name for the trigger, e.g. "Edit place". */
  label: string;
  multiline?: boolean;
  onCommit: (next: string) => Promise<unknown>;
  renderValue?: (value: string) => ReactNode;
  /** False for fields where empty is meaningless (an entity's name). */
  allowEmpty?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = value ?? "";

  function openWithDraft(next: boolean) {
    if (next) {
      // Re-seed from the live value on every open: the row may have been
      // re-rendered with newer data since the last edit.
      setDraft(current);
      setError(null);
    }
    setOpen(next);
  }

  async function commit() {
    const next = draft.trim();
    if (saving) return;
    if (!next && !allowEmpty) {
      setError("This can't be empty.");
      return;
    }
    if (next === current.trim()) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await onCommit(next);
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={openWithDraft}>
      <PopoverTrigger
        onClick={(e) => {
          // Rows are usually links; a click here edits, it doesn't navigate.
          e.preventDefault();
          e.stopPropagation();
        }}
        title={label}
        aria-label={label}
        className={cn(TRIGGER(!current), className)}
      >
        {current ? (renderValue?.(current) ?? current) : placeholder}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)] p-2"
        onClick={(e) => e.stopPropagation()}
      >
        {multiline ? (
          <textarea
            value={draft}
            autoFocus
            rows={3}
            aria-label={label}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void commit();
              }
            }}
            onBlur={() => {
              if (draft.trim() !== current.trim()) void commit();
            }}
            className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm leading-snug outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
          />
        ) : (
          <Input
            value={draft}
            autoFocus
            aria-label={label}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              }
            }}
            onBlur={() => {
              if (draft.trim() !== current.trim()) void commit();
            }}
            className="h-8 text-sm"
          />
        )}
        {error && <p className="mt-1.5 text-xs text-destructive">{error}</p>}
        {saving && (
          <p className="mt-1.5 text-xs text-muted-foreground">Saving…</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

export interface EditableOption {
  value: string;
  label: string;
}

export function EditableSelect({
  value,
  options,
  label,
  placeholder = "—",
  onCommit,
  allowClear = true,
  allowCustom = false,
  searchable = false,
  renderValue,
  className,
}: {
  value: string | null | undefined;
  options: EditableOption[];
  label: string;
  placeholder?: string;
  onCommit: (next: string) => Promise<unknown>;
  /** A "None" row that commits empty — the clear-on-empty leg. */
  allowClear?: boolean;
  /** Open vocabulary: a free-text row at the bottom, Enter commits it. */
  allowCustom?: boolean;
  /** A filter input at the top, for long lists (languages). */
  searchable?: boolean;
  renderValue?: (value: string) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = value ?? "";
  const currentLabel =
    options.find((o) => o.value === current)?.label || current;

  function openReset(next: boolean) {
    if (next) {
      setFilter("");
      setCustom("");
      setError(null);
    }
    setOpen(next);
  }

  async function commit(next: string) {
    if (saving) return;
    if (next === current) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await onCommit(next);
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const shown = filter.trim()
    ? options.filter((o) =>
        o.label.toLowerCase().includes(filter.trim().toLowerCase())
      )
    : options;

  return (
    <Popover open={open} onOpenChange={openReset}>
      <PopoverTrigger
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        title={label}
        aria-label={label}
        className={cn(TRIGGER(!current), className)}
      >
        {current ? (renderValue?.(current) ?? currentLabel) : placeholder}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-64 max-w-[calc(100vw-2rem)] flex-col p-1"
        onClick={(e) => e.stopPropagation()}
      >
        {searchable && (
          <Input
            value={filter}
            autoFocus
            aria-label={`Filter ${label.toLowerCase()}`}
            placeholder="Filter…"
            onChange={(e) => setFilter(e.target.value)}
            className="mb-1 h-8 text-sm"
          />
        )}
        <div className="max-h-64 overflow-y-auto">
          {shown.map((option) => (
            <button
              key={option.value}
              onClick={() => void commit(option.value)}
              className={cn(
                "block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                option.value === current && "font-semibold text-primary"
              )}
            >
              {option.label}
            </button>
          ))}
          {shown.length === 0 && !allowCustom && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              No matches.
            </p>
          )}
        </div>
        {allowClear && current && (
          <>
            <div className="my-1 border-t border-border" />
            <button
              onClick={() => void commit("")}
              className="block w-full rounded px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              None — let analysis fill it
            </button>
          </>
        )}
        {allowCustom && (
          <>
            <div className="my-1 border-t border-border" />
            <Input
              value={custom}
              aria-label={`New ${label.toLowerCase()}`}
              placeholder="Add your own…"
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && custom.trim()) {
                  e.preventDefault();
                  void commit(custom.trim().toLowerCase());
                }
              }}
              className="h-8 text-sm"
            />
          </>
        )}
        {error && <p className="mt-1 px-2 text-xs text-destructive">{error}</p>}
        {saving && (
          <p className="mt-1 px-2 text-xs text-muted-foreground">Saving…</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * ISO-prefix date editing: YYYY, YYYY-MM, or YYYY-MM-DD, precision inferred
 * from the shape and passed to onCommit alongside the value. Refuses to
 * commit anything else, with the rule stated inline.
 */
export function EditableDate({
  value,
  display,
  label,
  placeholder,
  onCommit,
  className,
}: {
  /** The raw ISO prefix, for editing. */
  value: string | null | undefined;
  /** The formatted form, for display ("Aug 8, 2026") — a node, so callers
   *  keep their own chip styling (the library's mono right-aligned date). */
  display: ReactNode;
  label: string;
  placeholder?: ReactNode;
  onCommit: (next: {
    value: string;
    precision: "day" | "month" | "year" | null;
  }) => Promise<unknown>;
  className?: string;
}) {
  return (
    <EditableText
      value={value}
      placeholder={placeholder ?? display ?? "Undated"}
      label={label}
      className={className}
      renderValue={() => display ?? value ?? ""}
      onCommit={async (next) => {
        if (!next) {
          await onCommit({ value: "", precision: null });
          return;
        }
        const precision = /^\d{4}$/.test(next)
          ? ("year" as const)
          : /^\d{4}-\d{2}$/.test(next)
            ? ("month" as const)
            : /^\d{4}-\d{2}-\d{2}$/.test(next)
              ? ("day" as const)
              : null;
        if (!precision) {
          throw new Error("Use YYYY, YYYY-MM, or YYYY-MM-DD");
        }
        await onCommit({ value: next, precision });
      }}
    />
  );
}
