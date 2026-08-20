import { Fragment, type ReactNode } from "react";
import { DocTypeEditor } from "@/components/documents/DocTypeEditor";
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
        <DocTypeEditor
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

function formatFallback(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? value.join(" · ") : null;
  if (typeof value === "boolean") return value ? "Yes" : null;
  return String(value);
}
