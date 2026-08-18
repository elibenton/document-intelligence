import { Fragment, useState, type ReactNode } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Autocomplete } from "@/components/ui/autocomplete";
import type { PropertyDef, PropertyOption } from "@/lib/views/types";
import {
  EditableDate,
  EditableSelect,
  EditableText,
} from "@/components/ui/editable";
import { cn } from "@/lib/utils";

/** What PropertyChips hands the page when an editable chip commits. */
export interface ChipCommit {
  field: string;
  value: string;
  precision: "day" | "month" | "year" | null;
}

/**
 * A row's visible properties, rendered in the order the user arranged them.
 *
 * Properties with a `render` supply their own chip; everything else falls back
 * to plain muted text from `format`. A property with nothing to say renders
 * nothing at all rather than an empty chip — a column of blank pills would be
 * worse than the absence it represents. The exception is an editable chip on
 * a page that passed `onEdit`: absence becomes the fillable slot, because a
 * value you can only edit when the AI already wrote one isn't editable.
 */
export function PropertyChips<T>({
  row,
  defs,
  visible,
  onEdit,
  liveOptions,
  className,
}: {
  row: T;
  defs: PropertyDef<T>[];
  visible: string[];
  /** Supplied by pages that allow inline editing; routes chip commits. */
  onEdit?: (row: T, commit: ChipCommit) => Promise<unknown>;
  /** Per-field option lists from live queries (project categories). */
  liveOptions?: Record<string, PropertyOption[]>;
  className?: string;
}) {
  const byId = new Map(defs.map((def) => [def.id, def]));

  const chips: Array<{ def: PropertyDef<T>; content: ReactNode }> = [];
  for (const id of visible) {
    const def = byId.get(id);
    if (!def) continue;
    const editable = def.editor !== undefined && onEdit !== undefined;
    let content = def.render
      ? def.render(row)
      : (def.format?.(row) ?? formatFallback(def.value(row)));
    if (content === null || content === undefined || content === "") {
      if (!editable) continue;
      content = null;
    }
    if (editable) {
      content = (
        <EditableChip
          row={row}
          def={def}
          display={content}
          onEdit={onEdit!}
          options={liveOptions?.[def.editor!.field]}
          liveKindOptions={liveOptions?.kind}
        />
      );
    }
    chips.push({ def, content });
  }

  if (chips.length === 0) return null;

  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      {chips.map((chip, index) => {
        // A joined chip sits flush against the one before it, so the category
        // and kind pills read as a single breadcrumb when both are shown and
        // adjacent — and as ordinary separate chips when they aren't.
        const joined =
          chip.def.joinWith !== undefined &&
          index > 0 &&
          chips[index - 1].def.id === chip.def.joinWith;
        return (
          <Fragment key={chip.def.id}>
            <span
              className={cn(
                "flex min-w-0 shrink-0 items-center",
                joined && "-ml-1.5"
              )}
            >
              {typeof chip.content === "string" ? (
                <span className="truncate text-xs text-muted-foreground">
                  {chip.content}
                </span>
              ) : (
                chip.content
              )}
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

/**
 * One editable chip: routes the def's declared control to the matching
 * Editable primitive, keeping the chip's own rendering as the at-rest face.
 * Sits above the row link's stretched hit area, the DocumentIdentityMenu way.
 */
function EditableChip<T>({
  row,
  def,
  display,
  onEdit,
  options,
  liveKindOptions,
}: {
  row: T;
  def: PropertyDef<T>;
  display: ReactNode;
  onEdit: (row: T, commit: ChipCommit) => Promise<unknown>;
  options?: PropertyOption[];
  liveKindOptions?: PropertyOption[];
}) {
  const editor = def.editor!;
  const raw = editor.read
    ? editor.read(row)
    : ((v) => (typeof v === "string" ? v : v == null ? null : String(v)))(
        def.value(row)
      );
  const label = `Edit ${def.label.toLowerCase()}`;
  const shown =
    display == null ? undefined : () => <>{display}</>;

  if (editor.control === "docType") {
    return (
      <span className="relative z-10">
        <DocTypeChipEditor
          display={display}
          label={label}
          categoryValue={raw}
          kindValue={
            typeof (row as { primaryKind?: unknown }).primaryKind === "string"
              ? ((row as { primaryKind?: string }).primaryKind ?? "")
              : ""
          }
          categoryOptions={options ?? []}
          kindOptions={liveKindOptions ?? []}
          onCategory={(value) =>
            onEdit(row, { field: editor.field, value, precision: null })
          }
          onKind={(value) =>
            onEdit(row, { field: "kind", value, precision: null })
          }
        />
      </span>
    );
  }
  if (editor.control === "date") {
    // The chip's own render is the display — the library's mono
    // right-aligned date keeps its styling inside the trigger.
    const formatted = display ?? def.format?.(row) ?? raw;
    return (
      <span className="relative z-10">
        <EditableDate
          value={raw}
          display={formatted}
          label={label}
          onCommit={({ value, precision }) =>
            onEdit(row, { field: editor.field, value, precision })
          }
        />
      </span>
    );
  }
  if (editor.control === "select") {
    return (
      <span className="relative z-10">
        <EditableSelect
          value={raw}
          options={options ?? editor.staticOptions ?? []}
          label={label}
          placeholder={def.label}
          allowClear={editor.allowClear ?? true}
          allowCustom={editor.allowCustom}
          searchable={editor.searchable}
          renderValue={shown && (() => shown())}
          onCommit={(value) =>
            onEdit(row, { field: editor.field, value, precision: null })
          }
        />
      </span>
    );
  }
  return (
    <span className="relative z-10">
      <EditableText
        value={raw}
        label={label}
        placeholder={def.label}
        renderValue={shown && (() => shown())}
        onCommit={(value) =>
          onEdit(row, { field: editor.field, value, precision: null })
        }
      />
    </span>
  );
}

/**
 * The two-tone category+kind pill's editor: one popover, both facts. The
 * category list moves the document between the project's buckets on click;
 * the type combobox renames its kind — suggestions come from every kind the
 * project already knows, and free text mints a new one (registering it as a
 * pill for every other document, via updateIdentity's kind upsert).
 */
function DocTypeChipEditor({
  display,
  label,
  categoryValue,
  kindValue,
  categoryOptions,
  kindOptions,
  onCategory,
  onKind,
}: {
  display: ReactNode;
  label: string;
  categoryValue: string | null;
  kindValue: string;
  categoryOptions: PropertyOption[];
  kindOptions: PropertyOption[];
  onCategory: (value: string) => Promise<unknown>;
  onKind: (value: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [kindDraft, setKindDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openReset(next: boolean) {
    if (next) {
      setKindDraft(kindValue);
      setError(null);
    }
    setOpen(next);
  }

  async function run(action: () => Promise<unknown>) {
    if (saving) return;
    setSaving(true);
    try {
      await action();
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function commitKind() {
    const next = kindDraft.trim().toLowerCase();
    if (!next || next === kindValue.toLowerCase()) {
      setOpen(false);
      return;
    }
    void run(() => onKind(next));
  }

  return (
    <Popover open={open} onOpenChange={openReset}>
      <PopoverTrigger
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        title={label}
        aria-label={label}
        className="inline-flex max-w-full rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:ring-2 data-[popup-open]:ring-ring"
      >
        {display ?? (
          <span className="text-xs italic text-muted-foreground">Type</span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-64 max-w-[calc(100vw-2rem)] flex-col p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-1 px-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Category
        </p>
        <div className="max-h-48 overflow-y-auto">
          {categoryOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => void run(() => onCategory(option.value))}
              className={cn(
                "block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                option.value === categoryValue && "font-semibold text-primary"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="mb-1 mt-2 px-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Type
        </p>
        <div
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitKind();
            }
          }}
        >
          <Autocomplete
            value={kindDraft}
            onValueChange={setKindDraft}
            items={kindOptions.filter((k) =>
              k.label.toLowerCase().includes(kindDraft.trim().toLowerCase())
            )}
            placeholder="e.g. legal brief"
            aria-label="Document type"
          />
        </div>
        <div className="mt-1.5 flex justify-end">
          <button
            onClick={commitKind}
            disabled={saving}
            className="rounded border bg-background px-2 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {saving ? "Saving…" : "Rename type"}
          </button>
        </div>
        {error && <p className="mt-1 px-1 text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}

function formatFallback(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? value.join(" · ") : null;
  if (typeof value === "boolean") return value ? "Yes" : null;
  return String(value);
}
