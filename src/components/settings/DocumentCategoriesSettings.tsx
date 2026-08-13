import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import {
  CATEGORY_COLOR_KEYS,
  CATEGORY_COLOR_PALETTE,
  styleForColor,
  type CategoryColor,
} from "@/components/documents/docTypeCategories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface CategoryBreakdown {
  categoryKey: string;
  documentCount: number;
  truncated: boolean;
  kinds: { name: string; count: number }[];
}

const TEXTAREA =
  "w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs leading-snug outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (color: CategoryColor) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {CATEGORY_COLOR_KEYS.map((color) => (
        <button
          key={color}
          type="button"
          aria-pressed={value === color}
          title={color}
          onClick={() => onChange(color)}
          className={cn(
            "h-5 w-5 rounded-full border-2 transition-colors",
            CATEGORY_COLOR_PALETTE[color].dark,
            value === color ? "border-foreground" : "border-transparent"
          )}
        />
      ))}
    </div>
  );
}

/**
 * One row: the enforced primary category's live pill preview, its editable
 * label/description/color, and — this is "see what the AI extraction has
 * pulled out and put into each of the categories" — the secondary types
 * Analyze has actually filed underneath it.
 */
function CategoryRow({
  category,
  breakdown,
}: {
  category: Doc<"documentCategories">;
  breakdown: CategoryBreakdown | undefined;
}) {
  const update = useMutation(api.documentCategories.update);
  const remove = useMutation(api.documentCategories.remove);

  const [label, setLabel] = useState(category.label);
  const [description, setDescription] = useState(category.description);
  const [color, setColor] = useState(category.color as CategoryColor);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const dirty =
    label.trim() !== category.label ||
    description.trim() !== category.description ||
    color !== category.color;

  const inUse = breakdown === undefined || breakdown.documentCount > 0;
  const kindCount = breakdown?.kinds.length ?? 0;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await update({ id: category._id, label, description, color });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (deleting) return;
    if (!window.confirm(`Delete the "${category.label}" category?`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await remove({ id: category._id });
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  const style = styleForColor(color);

  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none",
            style.dark
          )}
        >
          {label.trim() || category.label}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="h-8 max-w-xs text-sm"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What belongs in this bucket, so Analyze can tell it apart from the others"
            className={TEXTAREA}
          />
          <ColorPicker value={color} onChange={setColor} />
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={deleting || inUse}
              title={
                inUse
                  ? "Still assigned to at least one document — reassign or delete those first"
                  : undefined
              }
              onClick={() => void handleRemove()}
              className="text-destructive hover:text-destructive"
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
            {kindCount > 0 && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {expanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                {kindCount} type{kindCount === 1 ? "" : "s"} · {breakdown?.documentCount}{" "}
                document{breakdown?.documentCount === 1 ? "" : "s"}
              </button>
            )}
          </div>
          {deleteError && <p className="text-xs text-destructive">{deleteError}</p>}
          {expanded && breakdown && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {breakdown.kinds.map((k) => (
                <span
                  key={k.name}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-medium leading-none",
                    style.light
                  )}
                >
                  {k.name} · {k.count}
                </span>
              ))}
              {breakdown.truncated && (
                <span className="text-[10px] text-muted-foreground">and more…</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AddCategoryForm() {
  const create = useMutation(api.documentCategories.create);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<CategoryColor>("slate");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!label.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await create({ label: label.trim(), description: description.trim(), color });
      setLabel("");
      setDescription("");
      setColor("slate");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-4">
      <p className="mb-2 text-sm font-medium">Add a category</p>
      <div className="flex max-w-md flex-col gap-2">
        <Input
          placeholder="Name, e.g. Real Estate"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="h-8 text-sm"
        />
        <textarea
          placeholder="What belongs in this bucket, so Analyze can tell it apart from the others"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className={TEXTAREA}
        />
        <ColorPicker value={color} onChange={setColor} />
        <div>
          <Button size="sm" disabled={!label.trim() || saving} onClick={() => void add()}>
            {saving ? "Adding…" : "Add category"}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/**
 * The enforced primary-category taxonomy, managed from Settings: see every
 * category, add a new one, and see what Analyze has actually classified into
 * each one so far. Every category shown here is exactly what
 * DocTypePills draws from — the dark half of every pill in the app.
 */
export function DocumentCategoriesSettings() {
  const categories = useQuery(api.documentCategories.list);
  const breakdown = useQuery(api.documentCategories.bySecondaryType);
  const breakdownByKey = new Map(
    (breakdown ?? []).map((b) => [b.categoryKey, b as CategoryBreakdown])
  );

  return (
    <div className="mb-8 rounded-lg border bg-card divide-y">
      {categories === undefined ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        categories.map((category) => (
          <CategoryRow
            key={category._id}
            category={category}
            breakdown={breakdownByKey.get(category.key)}
          />
        ))
      )}
      <AddCategoryForm />
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Documents that don't confidently match any category above are filed as
        "Other" and shown without a pill.
      </p>
    </div>
  );
}
