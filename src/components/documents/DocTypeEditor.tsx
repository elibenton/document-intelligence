import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Autocomplete } from "@/components/ui/autocomplete";
import type { PropertyOption } from "@/lib/views/types";
import { DocTypePills } from "./DocTypePills";
import { cn } from "@/lib/utils";

/**
 * The two-tone category+kind pill's editor: one popover, both facts. The
 * category list moves the document between the project's buckets on click;
 * the type combobox renames its kind — suggestions come from every kind the
 * project already knows, and free text mints a new one (registering it as a
 * pill for every other document, via updateIdentity's kind upsert).
 *
 * Extracted from PropertyChips so the library rows and the document page
 * header share one editor; the header wraps it as DocumentTypeEditor below.
 */
export function DocTypeEditor({
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
        className="inline-flex max-w-full rounded-full transition-shadow hover:ring-2 hover:ring-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:ring-2 data-[popup-open]:ring-ring"
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

/**
 * The document page header's type pills, made editable: hover shows the ring,
 * click opens the same category/kind picker the library chips use. Fetches
 * its own option lists (the header has one document, not a table of rows) and
 * commits through the same mutations, so the header and the library cannot
 * disagree about what changing a type means.
 */
export function DocumentTypeEditor({
  document,
}: {
  document: Doc<"documents">;
}) {
  const categories = useQuery(
    api.documentCategories.list,
    document.projectId ? { projectId: document.projectId } : "skip"
  );
  const kinds = useQuery(
    api.kinds.list,
    document.projectId ? { projectId: document.projectId } : "skip"
  );
  const setField = useMutation(api.documents.setField);
  const updateIdentity = useMutation(api.documents.updateIdentity);

  const hasPills = Boolean(
    document.primaryCategory || document.primaryKind?.trim()
  );

  return (
    <DocTypeEditor
      display={
        hasPills ? (
          <DocTypePills
            projectId={document.projectId}
            primaryCategory={document.primaryCategory}
            primaryKind={document.primaryKind}
          />
        ) : undefined
      }
      label="Edit document type"
      categoryValue={document.primaryCategory ?? null}
      kindValue={document.primaryKind ?? ""}
      categoryOptions={(categories ?? []).map((c) => ({
        value: c.key,
        label: c.label,
      }))}
      kindOptions={(kinds ?? []).map((k) => ({ value: k.name, label: k.name }))}
      onCategory={(value) =>
        setField({ id: document._id, field: "primaryCategory", value })
      }
      // Replaces the primary kind, keeps any secondary ones — the same rule
      // the library chips apply; updateIdentity owns the multi-kind model.
      onKind={(value) =>
        updateIdentity({
          id: document._id,
          kinds: [value, ...(document.kinds ?? []).slice(1)],
        })
      }
    />
  );
}
