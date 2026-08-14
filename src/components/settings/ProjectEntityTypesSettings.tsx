import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  BaseEntityTypeChips,
  EntityTypeChip,
} from "@/components/projects/projectVocabulary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";

/**
 * The entity types this project looks for beyond people and organizations.
 *
 * Until now these could only be created ad-hoc from the document page and never
 * listed or removed anywhere — so a type added once was permanent and invisible.
 *
 * Removing one stops future extraction; entities already found under it are
 * left alone, which is `projectEntityTypes.remove`'s deliberate behaviour and
 * what the confirm prompt says.
 */
export function ProjectEntityTypesSettings({
  projectId,
}: {
  projectId: Id<"projects">;
}) {
  const types = useQuery(api.projectEntityTypes.list, { projectId });
  const create = useMutation(api.projectEntityTypes.create);
  const remove = useMutation(api.projectEntityTypes.remove);
  const confirm = useConfirm();

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function add() {
    if (!label.trim() || !description.trim() || saving) return;
    setSaving(true);
    try {
      await create({
        projectId,
        label: label.trim(),
        description: description.trim(),
      });
      setLabel("");
      setDescription("");
      setAdding(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id: Id<"projectEntityTypes">, name: string) {
    const ok = await confirm({
      title: `Stop looking for ${name}?`,
      body: "New documents won't be read for this type. Entities already found under it are kept — they came from documents that really were read that way.",
      confirmLabel: "Remove type",
      tone: "destructive",
    });
    if (!ok) return;
    await remove({ id });
  }

  return (
    <div className="mb-8 rounded-lg border bg-card p-4">
      {types === undefined ? (
        <Skeleton className="h-6 w-64" />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <BaseEntityTypeChips />
          {types.map((type) => (
            <EntityTypeChip
              key={type._id}
              label={type.label}
              description={type.description}
              onRemove={() => void handleRemove(type._id, type.label)}
            />
          ))}
        </div>
      )}

      <p className="mt-2 text-xs text-muted-foreground">
        People and organizations are always extracted. Adding a type changes what{" "}
        <em>new</em> documents are read for — existing ones keep what they found
        until you re-run them.
      </p>

      {adding ? (
        <div className="mt-3 grid max-w-md gap-1.5">
          <Input
            value={label}
            autoFocus
            aria-label="Entity type name"
            placeholder="Entity type, e.g. Vessels"
            className="h-8 text-sm"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAdding(false);
            }}
          />
          <textarea
            value={description}
            rows={2}
            aria-label="Entity type description"
            placeholder="What counts as one, told to the extractor as a definition"
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAdding(false);
            }}
            className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs leading-snug outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
          />
          <div className="flex justify-end gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!label.trim() || !description.trim() || saving}
              onClick={() => void add()}
            >
              {saving ? "Adding…" : "Add type"}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3.5" /> Add entity type
        </Button>
      )}
    </div>
  );
}
