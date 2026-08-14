import { useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router";
import { ChevronLeft, ChevronRight, Plus, Quote, Shapes, Tags } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import {
  DEFAULT_TEMPLATE_KEY,
  PROJECT_TEMPLATES,
  type CitationStyle,
  type TemplateCategory,
  type TemplateEntityType,
} from "../../../convex/projectTemplates";
import { CATEGORY_COLOR_KEYS } from "@/components/documents/docTypeCategories";
import {
  BaseEntityTypeChips,
  CitationStylePicker,
  DocumentTypePill,
  EntityTypeChip,
  SECTION_LABEL,
} from "@/components/projects/projectVocabulary";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Creating a project is a decision about three things — what document types it
 * sorts into, what entities it looks for, and how its answers cite sources —
 * and all three are hard to pick from nothing. So the templates are not a
 * radio group but a carousel of pages, each showing its own answer to all
 * three, editable in place before the project exists.
 *
 * Everything here is drawn the way it will look inside the project: document
 * types as the coloured pill `DocTypePills` renders, entity types as the muted
 * chip the Entities list uses. The point is that the choice is legible as the
 * thing it produces, rather than as a form that describes it.
 *
 * `PROJECT_TEMPLATES` is imported from the Convex side rather than restated —
 * `projects.create` seeds from the same constant, and a second copy would let
 * a page promise six types while the mutation wrote five.
 */

/** One template as the user has edited it. Seeded from the template, then owned. */
interface Draft {
  categories: TemplateCategory[];
  entityTypes: TemplateEntityType[];
  citationStyle: CitationStyle;
}

/** A template's own answer, before the user has touched it. Pure, so the
 *  updater in `setDrafts` can seed a page it has never seen. */
function seedDraft(key: string): Draft {
  const template = PROJECT_TEMPLATES.find((t) => t.key === key)!;
  return {
    categories: template.categories,
    entityTypes: template.entityTypes,
    citationStyle: template.citationStyle,
  };
}

/** A colour for a type the user just invented, cycling the palette so two
 *  additions never land on the same one back to back. */
function nextColor(taken: TemplateCategory[]): string {
  const used = new Set(taken.map((c) => c.color));
  return (
    CATEGORY_COLOR_KEYS.find((color) => !used.has(color)) ??
    CATEGORY_COLOR_KEYS[taken.length % CATEGORY_COLOR_KEYS.length]
  );
}

/**
 * A name/description pair, revealed by "Add". Both are required for the same
 * reason `AddCategoryForm` asks for both: the description is what Analyze is
 * told the bucket means, and an empty one is a category the model cannot use.
 */
function AddTypeForm({
  namePlaceholder,
  descriptionPlaceholder,
  onAdd,
  onCancel,
}: {
  namePlaceholder: string;
  descriptionPlaceholder: string;
  onAdd: (label: string, description: string) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const ready = label.trim() && description.trim();

  return (
    <div className="mt-2 grid gap-1.5 rounded-lg border bg-background p-2">
      <Input
        value={label}
        autoFocus
        aria-label={namePlaceholder}
        placeholder={namePlaceholder}
        className="h-8 text-sm"
        onChange={(e) => setLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      />
      <textarea
        value={description}
        rows={2}
        aria-label={descriptionPlaceholder}
        placeholder={descriptionPlaceholder}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
        className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs leading-snug outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!ready}
          onClick={() => onAdd(label.trim(), description.trim())}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/** One page of the carousel: a template, as edited. */
function TemplatePage({
  label,
  description,
  draft,
  onChange,
}: {
  label: string;
  description: string;
  draft: Draft;
  /** An updater, not a value. Two edits dispatched in one tick both read the
   *  same `draft` prop from the render closure, so passing a finished object
   *  lets the second silently discard the first — removing a type and changing
   *  the citation style in the same tick lost the removal. */
  onChange: (update: (prev: Draft) => Draft) => void;
}) {
  const [adding, setAdding] = useState<"category" | "entity" | null>(null);

  return (
    <section
      aria-label={label}
      className="w-[30rem] shrink-0 snap-center rounded-xl border bg-card p-4"
    >
      <h3 className="text-sm font-semibold">{label}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>

      {/* Document types — the same two-tone pill the library draws, minus the
          kind half, which no document has supplied yet. */}
      <p className={cn(SECTION_LABEL, "mt-4")}>
        <Tags className="size-3" />
        Document types
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {draft.categories.map((category) => (
          <DocumentTypePill
            key={category.label}
            label={category.label}
            color={category.color}
            description={category.description}
            onRemove={() =>
              onChange((prev) => ({
                ...prev,
                categories: prev.categories.filter(
                  (c) => c.label !== category.label
                ),
              }))
            }
          />
        ))}
        {draft.categories.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No document types — everything files as “Other” until you add some.
          </p>
        )}
      </div>
      {adding === "category" ? (
        <AddTypeForm
          namePlaceholder="Type name, e.g. Permits"
          descriptionPlaceholder="What belongs in this bucket, so Analyze can tell it apart from the others"
          onCancel={() => setAdding(null)}
          onAdd={(newLabel, newDescription) => {
            onChange((prev) => ({
              ...prev,
              categories: [
                ...prev.categories,
                {
                  label: newLabel,
                  description: newDescription,
                  color: nextColor(prev.categories),
                },
              ],
            }));
            setAdding(null);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding("category")}
          className="mt-2 inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <Plus className="size-3" /> Add document type
        </button>
      )}

      {/* Entity types — People and Organizations are hard-coded in the graph
          pass (relationshipsNode.ts), so they are shown as the given they are
          rather than as something to remove. */}
      <p className={cn(SECTION_LABEL, "mt-4")}>
        <Shapes className="size-3" />
        Entity types
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <BaseEntityTypeChips />
        {draft.entityTypes.map((type) => (
          <EntityTypeChip
            key={type.label}
            label={type.label}
            description={type.description}
            onRemove={() =>
              onChange((prev) => ({
                ...prev,
                entityTypes: prev.entityTypes.filter(
                  (t) => t.label !== type.label
                ),
              }))
            }
          />
        ))}
      </div>
      <p className="mt-1 text-2xs text-muted-foreground">
        People and organizations are always extracted.
      </p>
      {adding === "entity" ? (
        <AddTypeForm
          namePlaceholder="Entity type, e.g. Vessels"
          descriptionPlaceholder="What counts as one, told to the extractor as a definition"
          onCancel={() => setAdding(null)}
          onAdd={(newLabel, newDescription) => {
            onChange((prev) => ({
              ...prev,
              entityTypes: [
                ...prev.entityTypes,
                { label: newLabel, description: newDescription },
              ],
            }));
            setAdding(null);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setAdding("entity")}
          className="mt-2 inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
        >
          <Plus className="size-3" /> Add entity type
        </button>
      )}

      <p className={cn(SECTION_LABEL, "mt-4")}>
        <Quote className="size-3" />
        Citation style
      </p>
      <div className="mt-1.5">
        <CitationStylePicker
          value={draft.citationStyle}
          onChange={(style) => onChange((prev) => ({ ...prev, citationStyle: style }))}
        />
      </div>
    </section>
  );
}

export function NewProjectDialog() {
  const navigate = useNavigate();
  const createProject = useMutation(api.projects.create);
  const scroller = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(
    Math.max(
      0,
      PROJECT_TEMPLATES.findIndex((t) => t.key === DEFAULT_TEMPLATE_KEY)
    )
  );
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seeded lazily so an untouched template stays exactly the shared constant,
  // and an edited one survives scrolling away and back.
  const draftFor = useMemo(
    () =>
      (key: string): Draft =>
        drafts[key] ?? seedDraft(key),
    [drafts]
  );

  const template = PROJECT_TEMPLATES[active];

  function reset() {
    setName("");
    setDescription("");
    setActive(
      Math.max(
        0,
        PROJECT_TEMPLATES.findIndex((t) => t.key === DEFAULT_TEMPLATE_KEY)
      )
    );
    setDrafts({});
    setError(null);
  }

  /** Which page is centred, from the scroll position — the carousel's own
   *  state, rather than a selection the user has to make twice. */
  function syncActive() {
    const el = scroller.current;
    if (!el) return;
    const middle = el.scrollLeft + el.clientWidth / 2;
    let nearest = 0;
    let best = Infinity;
    [...el.children].forEach((child, index) => {
      const node = child as HTMLElement;
      const centre = node.offsetLeft + node.offsetWidth / 2;
      const distance = Math.abs(centre - middle);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    setActive(nearest);
  }

  function scrollToPage(index: number) {
    const el = scroller.current;
    const target = el?.children[index] as HTMLElement | undefined;
    if (!el || !target) return;
    el.scrollTo({
      left: target.offsetLeft - (el.clientWidth - target.offsetWidth) / 2,
      behavior: "smooth",
    });
    setActive(index);
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    const draft = draftFor(template.key);
    setCreating(true);
    setError(null);
    try {
      const { slug } = await createProject({
        name: trimmed,
        description: description.trim() || undefined,
        templateKey: template.key,
        citationStyle: draft.citationStyle,
        categories: draft.categories,
        entityTypes: draft.entityTypes,
      });
      setOpen(false);
      reset();
      navigate(`/p/${slug}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <Plus className="size-3.5" /> New Project
      </DialogTrigger>

      <DialogContent className="max-w-2xl">
        <div className="grid gap-1.5">
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project is its own corpus. Pick a starting point and adjust it —
            everything here is editable later in project settings too.
          </DialogDescription>
        </div>

        <div className="grid gap-2">
          <Input
            id="new-project-name"
            value={name}
            autoFocus
            aria-label="Project name"
            placeholder="Project name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create();
            }}
          />
          <textarea
            value={description}
            rows={2}
            aria-label="Project description"
            placeholder="What this project is about (optional)"
            onChange={(e) => setDescription(e.target.value)}
            className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs leading-snug outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
          />
        </div>

        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Starting point</p>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Previous template"
              disabled={active === 0}
              onClick={() => scrollToPage(active - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-2xs tabular-nums text-muted-foreground">
              {active + 1} / {PROJECT_TEMPLATES.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Next template"
              disabled={active === PROJECT_TEMPLATES.length - 1}
              onClick={() => scrollToPage(active + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>

        <div
          ref={scroller}
          onScroll={syncActive}
          className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-1 pb-2"
        >
          {PROJECT_TEMPLATES.map((option) => (
            <TemplatePage
              key={option.key}
              label={option.label}
              description={option.description}
              draft={draftFor(option.key)}
              onChange={(update) =>
                setDrafts((all) => ({
                  ...all,
                  [option.key]: update(all[option.key] ?? seedDraft(option.key)),
                }))
              }
            />
          ))}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <DialogClose
            render={
              <Button type="button" variant="ghost" size="sm" disabled={creating} />
            }
          >
            Cancel
          </DialogClose>
          <Button
            type="button"
            size="sm"
            disabled={!name.trim() || creating}
            onClick={() => void create()}
          >
            {creating ? "Creating…" : `Create with ${template.label}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
