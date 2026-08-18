import { useState } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router";
import { Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/use-confirm";
import { CitationStyleSettings } from "@/components/settings/CitationStyleSettings";

/**
 * The project's own row: name, description, citation style, and the delete
 * button. Name and description used to be edited inline on the projects grid
 * while citation style lived here — two homes for one table row. A rename
 * re-allocates the slug, so a successful save navigates to the new address
 * instead of leaving the user on a URL that no longer exists.
 */
export function ProjectDetailsSettings({
  project,
}: {
  project: Doc<"projects">;
}) {
  const updateProject = useMutation(api.projects.update);
  const removeProject = useMutation(api.projects.remove);
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [saving, setSaving] = useState(false);

  const dirty =
    name.trim() !== project.name ||
    description.trim() !== (project.description ?? "");

  async function save() {
    const trimmed = name.trim();
    if (!trimmed || !dirty || saving) return;
    setSaving(true);
    try {
      const result = await updateProject({
        id: project._id,
        name: trimmed,
        description: description.trim(),
      });
      if (result.slug && result.slug !== project.slug) {
        void navigate(`/p/${result.slug}/settings`, { replace: true });
      }
    } finally {
      setSaving(false);
    }
  }

  /**
   * Deleting a project takes every document, entity and search in it — by far
   * the most destructive thing in the app — so the prompt names the project
   * rather than asking a generic "are you sure".
   */
  async function handleDelete() {
    const ok = await confirm({
      title: `Permanently delete “${project.name}”?`,
      body: "This deletes the project and every document, page, entity, extraction and saved search inside it. It cannot be undone.",
      confirmLabel: "Delete project",
      tone: "destructive",
    });
    if (!ok) return;
    await removeProject({ id: project._id });
    void navigate("/", { replace: true });
  }

  return (
    <div className="mb-8 rounded-lg border bg-card p-4">
      <div className="flex max-w-md flex-col gap-2">
        <label htmlFor="project-name" className="text-sm font-medium">
          Name
        </label>
        <Input
          id="project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 text-sm"
        />
        <label htmlFor="project-description" className="mt-1 text-sm font-medium">
          Description
        </label>
        <textarea
          id="project-description"
          value={description}
          rows={2}
          placeholder="What this corpus is (optional)"
          onChange={(e) => setDescription(e.target.value)}
          className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs leading-snug outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
        />
        <div className="mt-1 flex items-center gap-2">
          <Button size="sm" disabled={!name.trim() || !dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="mt-4 border-t pt-4">
        <p className="mb-2 text-sm font-medium">Citation style</p>
        <p className="mb-3 text-xs text-muted-foreground">
          How search answers cite the documents they quote.
        </p>
        <CitationStyleSettings
          projectId={project._id}
          citationStyle={project.citationStyle}
        />
      </div>

      <div className="mt-4 border-t pt-4">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => void handleDelete()}
        >
          <Trash2 className="size-3.5" />
          Delete project
        </Button>
      </div>
    </div>
  );
}
