import { query, mutation, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

import { beginDocumentTeardown } from "./documents";
import { seedCategories } from "./documentCategories";
import { seedEntityTypes } from "./projectEntityTypes";
import {
  CITATION_STYLES,
  DEFAULT_TEMPLATE_KEY,
  templateByKey,
  type CitationStyle,
} from "./projectTemplates";
import { slugify } from "./slug";

// ---------------------------------------------------------------------------
// List all projects (newest first) with document counts for the picker cards
// ---------------------------------------------------------------------------

export const list = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_createdAt")
      .order("desc")
      .take(100);

    return await Promise.all(
      projects.map(async (project) => {
        // Bounded count — picker cards only need "how big is this, roughly"
        const docs = await ctx.db
          .query("documents")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .take(500);
        return { ...project, documentCount: docs.length };
      })
    );
  },
});

// ---------------------------------------------------------------------------
// Search projects by name (picker search bar)
// ---------------------------------------------------------------------------

export const search = query({
  args: { q: v.string() },
  handler: async (ctx, args) => {
    const q = args.q.trim();
    if (!q) return [];
    const hits = await ctx.db
      .query("projects")
      .withSearchIndex("search_name", (s) => s.search("name", q))
      .take(20);
    return await Promise.all(
      hits.map(async (project) => {
        const docs = await ctx.db
          .query("documents")
          .withIndex("by_project", (s) => s.eq("projectId", project._id))
          .take(500);
        return { ...project, documentCount: docs.length };
      })
    );
  },
});

// ---------------------------------------------------------------------------
// Get a single project
// ---------------------------------------------------------------------------

export const get = query({
  args: { id: v.id("projects") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Resolve `/p/:slug`. `.first()` rather than `.unique()` for the same reason
 * `allocateSlug` uses it: an older build could write unchecked slugs, so a
 * deployment may already hold duplicates, and throwing here would take the
 * project page down rather than landing on one of them.
 */
export const getBySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
  },
});

// ---------------------------------------------------------------------------
// Create a project (slug de-duplicated with a numeric suffix)
// ---------------------------------------------------------------------------

/**
 * Allocate a slug that no other project holds, suffixing `-2`, `-3`, ... on
 * collision. `exclude` is the project being renamed, so keeping its own slug
 * isn't treated as a conflict.
 *
 * Uses `.first()` rather than `.unique()`: an older build let `update` write
 * unchecked slugs, so a deployment can already hold duplicates, and `.unique()`
 * would throw on them and make every subsequent create fail.
 */
async function allocateSlug(
  ctx: MutationCtx,
  name: string,
  exclude?: Id<"projects">
): Promise<string> {
  const base = slugify(name) || "project";
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first();
    if (!existing || existing._id === exclude) return slug;
  }
}

/**
 * Create a project and everything it starts out believing.
 *
 * The template supplies the categories, entity types and citation style; the
 * three optional overrides are what the new-project dialog sends when the user
 * edited them in the review step, before the project existed. Sending nothing
 * but a `templateKey` is the common path and the one the wire is cheap for.
 *
 * All of it lands in this one transaction on purpose: a project that is briefly
 * visible without its categories is a project whose first upload can be
 * analyzed against an empty taxonomy and filed as "other".
 */
export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    templateKey: v.optional(v.string()),
    citationStyle: v.optional(v.string()),
    categories: v.optional(
      v.array(
        v.object({
          label: v.string(),
          description: v.string(),
          color: v.string(),
        })
      )
    ),
    entityTypes: v.optional(
      v.array(v.object({ label: v.string(), description: v.string() }))
    ),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("Project name is required");

    const template = templateByKey(args.templateKey ?? DEFAULT_TEMPLATE_KEY);
    if (!template) throw new Error(`Unknown project template: ${args.templateKey}`);

    // Validated rather than trusted: this is a public endpoint, and the value
    // decides which CSL style the renderer loads.
    let citationStyle: CitationStyle = template.citationStyle;
    if (args.citationStyle) {
      const chosen = CITATION_STYLES.find((s) => s === args.citationStyle);
      if (!chosen) {
        throw new Error(`Unknown citation style: ${args.citationStyle}`);
      }
      citationStyle = chosen;
    }

    // The slug comes back with the id because the caller navigates straight to
    // /p/:slug, and re-deriving it client-side would miss the -2 suffix that
    // allocateSlug may have just added.
    const slug = await allocateSlug(ctx, name);
    const id = await ctx.db.insert("projects", {
      name,
      slug,
      description: args.description,
      citationStyle,
      createdAt: Date.now(),
    });

    await seedCategories(ctx, id, args.categories ?? template.categories);
    await seedEntityTypes(ctx, id, args.entityTypes ?? template.entityTypes);

    return { id, slug };
  },
});

// ---------------------------------------------------------------------------
// Rename / edit a project
// ---------------------------------------------------------------------------

export const update = mutation({
  args: {
    id: v.id("projects"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, string> = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Project name is required");
      patch.name = name;
      // Rename goes through the same allocator as create, so a rename can
      // never mint a duplicate (or empty) slug.
      patch.slug = await allocateSlug(ctx, name, args.id);
    }
    if (args.description !== undefined) patch.description = args.description;
    await ctx.db.patch(args.id, patch);
  },
});

// ---------------------------------------------------------------------------
// Delete a project and everything inside it
// ---------------------------------------------------------------------------

/**
 * Rows deleted per transaction. Documents are far lower than the rest because
 * each one frees storage and schedules its own cascade.
 */
const PROJECT_DOCUMENT_BATCH = 4;
const PROJECT_ROW_BATCH = 64;

/** Phases of `drainProjectDeletion`, in the order they run. */
const PROJECT_PHASE = {
  documents: 0,
  entities: 1,
  searches: 2,
  views: 3,
  taxonomy: 4,
  done: 5,
} as const;

/**
 * Delete a project and every document, entity, search and view inside it.
 *
 * The project row goes immediately so the picker updates, and the contents are
 * drained a bounded batch per transaction — a project is an unbounded amount of
 * data, and a single-transaction delete would roll back on its limits and leave
 * the project permanently undeletable.
 *
 * Documents are handed to the same teardown a single delete uses, so each one
 * cancels its queued work, frees its files, and cascades its own derived rows.
 */
export const remove = mutation({
  args: { id: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.id);
    if (!project) return null;
    await ctx.db.delete(args.id);
    await ctx.scheduler.runAfter(0, internal.projects.drainProjectDeletion, {
      projectId: args.id,
      phase: PROJECT_PHASE.documents,
    });
    return null;
  },
});

export const drainProjectDeletion = internalMutation({
  args: { projectId: v.id("projects"), phase: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { projectId } = args;
    let more = false;

    if (args.phase === PROJECT_PHASE.documents) {
      const docs = await ctx.db
        .query("documents")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(PROJECT_DOCUMENT_BATCH);
      for (const doc of docs) await beginDocumentTeardown(ctx, doc._id);
      more = docs.length === PROJECT_DOCUMENT_BATCH;
    } else if (args.phase === PROJECT_PHASE.entities) {
      more = await drainProjectEntities(ctx, projectId);
    } else if (args.phase === PROJECT_PHASE.searches) {
      const searches = await ctx.db
        .query("searches")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(PROJECT_ROW_BATCH);
      for (const row of searches) await ctx.db.delete(row._id);
      more = searches.length === PROJECT_ROW_BATCH;
    } else if (args.phase === PROJECT_PHASE.views) {
      const views = await ctx.db
        .query("projectViews")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(PROJECT_ROW_BATCH);
      for (const row of views) await ctx.db.delete(row._id);
      more = views.length === PROJECT_ROW_BATCH;
    } else if (args.phase === PROJECT_PHASE.taxonomy) {
      // What the project believed: its categories, the kinds it accumulated,
      // and the entity types it was told to look for. These became per-project
      // rows without their own owner, so deleting the project has to take them
      // — otherwise every deleted project leaves its vocabulary behind forever.
      const categories = await ctx.db
        .query("documentCategories")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(PROJECT_ROW_BATCH);
      for (const row of categories) await ctx.db.delete(row._id);

      const kinds = await ctx.db
        .query("documentKinds")
        .withIndex("by_project_and_name", (q) => q.eq("projectId", projectId))
        .take(PROJECT_ROW_BATCH);
      for (const row of kinds) await ctx.db.delete(row._id);

      const entityTypes = await ctx.db
        .query("projectEntityTypes")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .take(PROJECT_ROW_BATCH);
      for (const row of entityTypes) await ctx.db.delete(row._id);

      more =
        categories.length === PROJECT_ROW_BATCH ||
        kinds.length === PROJECT_ROW_BATCH ||
        entityTypes.length === PROJECT_ROW_BATCH;
    } else {
      return null;
    }

    const next = more ? args.phase : args.phase + 1;
    if (next >= PROJECT_PHASE.done) return null;
    await ctx.scheduler.runAfter(0, internal.projects.drainProjectDeletion, {
      projectId,
      phase: next,
    });
    return null;
  },
});

/**
 * Entities belonging to this project, with the rows that point at them.
 *
 * Most of an entity's dependents are document-scoped and will already have gone
 * with their documents; this sweep exists for what survives that — a `starred`
 * entity the document cascade deliberately spares, and any legacy row whose
 * document link was never set. Deleting the entity without them would leave a
 * dangling `v.id("entities")`, which Convex does not police.
 *
 * Runs alongside the document cascades rather than after them. That is safe:
 * conflicting transactions are retried, and every read here is re-done on retry.
 */
async function drainProjectEntities(
  ctx: MutationCtx,
  projectId: Id<"projects">
): Promise<boolean> {
  const entities = await ctx.db
    .query("entities")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .take(8);

  for (const entity of entities) {
    let deferred = false;

    const sourceRels = await ctx.db
      .query("relationships")
      .withIndex("by_source", (q) => q.eq("sourceEntityId", entity._id))
      .take(PROJECT_ROW_BATCH);
    for (const rel of sourceRels) await ctx.db.delete(rel._id);
    deferred ||= sourceRels.length === PROJECT_ROW_BATCH;

    const targetRels = await ctx.db
      .query("relationships")
      .withIndex("by_target", (q) => q.eq("targetEntityId", entity._id))
      .take(PROJECT_ROW_BATCH);
    for (const rel of targetRels) await ctx.db.delete(rel._id);
    deferred ||= targetRels.length === PROJECT_ROW_BATCH;

    const roles = await ctx.db
      .query("entityRoles")
      .withIndex("by_entity", (q) => q.eq("entityId", entity._id))
      .take(PROJECT_ROW_BATCH);
    for (const role of roles) await ctx.db.delete(role._id);
    deferred ||= roles.length === PROJECT_ROW_BATCH;

    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_entity", (q) => q.eq("entityId", entity._id))
      .take(PROJECT_ROW_BATCH);
    for (const mention of mentions) await ctx.db.delete(mention._id);
    deferred ||= mentions.length === PROJECT_ROW_BATCH;

    const asSource = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_source_and_target", (q) =>
        q.eq("sourceEntityId", entity._id)
      )
      .take(PROJECT_ROW_BATCH);
    for (const s of asSource) await ctx.db.delete(s._id);
    deferred ||= asSource.length === PROJECT_ROW_BATCH;

    const asTarget = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_target", (q) => q.eq("targetEntityId", entity._id))
      .take(PROJECT_ROW_BATCH);
    for (const s of asTarget) await ctx.db.delete(s._id);
    deferred ||= asTarget.length === PROJECT_ROW_BATCH;

    // Still has dependents that didn't fit this batch — leave the entity in
    // place and finish it on the next pass, so nothing is ever orphaned.
    if (!deferred) await ctx.db.delete(entity._id);
  }

  return entities.length > 0;
}
