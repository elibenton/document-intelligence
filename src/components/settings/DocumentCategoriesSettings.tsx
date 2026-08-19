import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import {
  nextColor,
  styleForColor,
} from "@/components/documents/docTypeCategories";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/use-confirm";

const TEXTAREA =
  "w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs leading-snug outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring";

/**
 * One row: the enforced primary category's live pill preview and its editable
 * label/description — the description is injected verbatim into the Analyze
 * prompt, so those two fields are the whole setting. Color is assigned from
 * the palette on creation and never edited; deletion of an in-use category is
 * refused by the server, and that refusal is what renders below the buttons.
 */
function CategoryRow({ category }: { category: Doc<"documentCategories"> }) {
  const update = useMutation(api.documentCategories.update);
  const remove = useMutation(api.documentCategories.remove);

  const [label, setLabel] = useState(category.label);
  const [nickname, setNickname] = useState(category.nickname ?? "");
  const [description, setDescription] = useState(category.description);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const confirm = useConfirm();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const dirty =
    label.trim() !== category.label ||
    nickname.trim() !== (category.nickname ?? "") ||
    description.trim() !== category.description;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await update({
        id: category._id,
        label,
        nickname,
        description,
        color: category.color,
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (deleting) return;
    const ok = await confirm({
      title: `Delete the “${category.label}” category?`,
      body: "Documents already sorted into it keep their category until they are re-analyzed.",
      confirmLabel: "Delete category",
      tone: "destructive",
    });
    if (!ok) return;
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

  const style = styleForColor(category.color);

  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-2xs font-medium leading-none",
            style.dark
          )}
        >
          {label.trim() || category.label}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex max-w-md gap-2">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Category name"
              className="h-8 min-w-0 flex-1 text-sm"
            />
            {/* Presentation only — the pill shows this, prompts never do. */}
            <Input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Nickname, e.g. Gov"
              aria-label="Category nickname"
              className="h-8 w-36 text-sm"
            />
          </div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What belongs in this bucket, so Analyze can tell it apart from the others"
            className={TEXTAREA}
          />
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={deleting}
              onClick={() => void handleRemove()}
              className="text-destructive hover:text-destructive"
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
          {deleteError && <p className="text-xs text-destructive">{deleteError}</p>}
        </div>
      </div>
    </div>
  );
}

function AddCategoryForm({
  projectId,
  existing,
}: {
  projectId: Id<"projects">;
  existing: { color: string }[];
}) {
  const create = useMutation(api.documentCategories.create);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!label.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await create({
        projectId,
        label: label.trim(),
        description: description.trim(),
        color: nextColor(existing),
      });
      setLabel("");
      setDescription("");
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
 * This project's enforced primary-category taxonomy. Every category shown here
 * is exactly what DocTypePills draws from — the dark half of every pill in the
 * project.
 */
export function DocumentCategoriesSettings({
  projectId,
}: {
  projectId: Id<"projects">;
}) {
  const categories = useQuery(api.documentCategories.list, { projectId });

  return (
    <div className="mb-8 rounded-lg border bg-card divide-y">
      {categories === undefined ? (
        <div className="space-y-2 p-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        categories.map((category) => (
          <CategoryRow key={category._id} category={category} />
        ))
      )}
      <AddCategoryForm projectId={projectId} existing={categories ?? []} />
      <p className="px-4 py-3 text-xs text-muted-foreground">
        Documents that don't confidently match any category above are filed as
        "Other" and shown without a pill.
      </p>
    </div>
  );
}
