import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("documents")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .order("desc")
      .collect();
    const active = docs.filter((d) => d.archivedAt === undefined);

    // Analyze is the one stage with no state of its own on the document: the
    // row sits at "parsed" from the moment the scan lands until extraction
    // starts, so "is Analyze running, or did it fail?" is only answerable from
    // its job row. The library labels rows with that answer, so it rides along
    // here — one indexed read, and only for the rows actually in that gap,
    // rather than a subscription per visible row.
    return await Promise.all(
      active.map(async (doc) => {
        if (doc.status !== "parsed") return { ...doc, analyzeStatus: null };
        const job = await ctx.db
          .query("processingJobs")
          .withIndex("by_document", (q) =>
            q.eq("documentId", doc._id).eq("stage", "analyze")
          )
          .first();
        return { ...doc, analyzeStatus: job?.status ?? null };
      })
    );
  },
});

/**
 * Account-level blockers affecting document processing, for the global
 * banner. Running out of API credits stops every upload from progressing, so
 * it can't be reported only as red text on whichever document happened to be
 * running — the user needs to see the cause and the fix wherever they are.
 *
 * Scans by status index (failed documents only) and reports the most recent
 * blocking failure plus how many documents are stuck behind it.
 */
export const processingBlocker = query({
  args: {},
  handler: async (ctx) => {
    const failed = await ctx.db
      .query("documents")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .collect();

    const blocked = failed.filter(
      (d) =>
        d.archivedAt === undefined &&
        (d.errorCode === "insufficient_credits" ||
          d.errorCode === "invalid_api_key")
    );
    if (blocked.length === 0) return null;

    // Newest failure wins: if the key was replaced after a credit outage, the
    // banner should describe the condition the user is actually in now.
    const latest = blocked.reduce((a, b) => (b.uploadedAt > a.uploadedAt ? b : a));
    return {
      code: latest.errorCode as "insufficient_credits" | "invalid_api_key",
      message: latest.errorMessage ?? "Document processing is blocked.",
      affectedCount: blocked.length,
    };
  },
});

/** Archive (hide from the main list) or restore a document. Non-destructive:
 * all pages, blocks, entities, and extractions stay intact. */
export const setArchived = mutation({
  args: { id: v.id("documents"), archived: v.boolean() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return;
    await ctx.db.patch(args.id, {
      archivedAt: args.archived ? Date.now() : undefined,
    });
  },
});

export const get = query({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/** Rotate every page while preserving any page-specific adjustment. */
export const rotateDocument = mutation({
  args: {
    id: v.id("documents"),
    degrees: v.union(v.literal(90), v.literal(-90)),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);
    if (!document) return null;
    const next = ((document.viewerRotation ?? 0) + args.degrees + 360) % 360;
    await ctx.db.patch(args.id, {
      viewerRotation: next as 0 | 90 | 180 | 270,
    });
    return null;
  },
});

/** Cap on kinds per document — a document that is eight things is untagged. */
const MAX_KINDS = 8;

/**
 * Human edits to a document's identity: the title shown in the UI and the
 * semantic kinds it belongs to (see the identity menu on the left of every
 * document name).
 *
 * Both fields are optional and independent — the menu sends only what
 * changed. An empty `displayName` clears the human title and the "human"
 * stamp with it, which puts the document back in reach of the AI rename pass.
 */
export const updateIdentity = mutation({
  args: {
    id: v.id("documents"),
    displayName: v.optional(v.string()),
    kinds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return;

    const patch: {
      displayName?: string;
      displayNameSource?: string;
      kinds?: string[];
      primaryKind?: string;
      kindSource?: string;
    } = {};

    if (args.displayName !== undefined) {
      const title = args.displayName.trim();
      // A title equal to the filename is the same as having none: the UI
      // would print the same string twice, once per line.
      const keep = title && title !== doc.name;
      patch.displayName = keep ? title : undefined;
      patch.displayNameSource = keep ? "human" : undefined;
    }

    if (args.kinds !== undefined) {
      const kinds = [
        ...new Set(
          args.kinds.map((k) => k.trim().toLowerCase()).filter(Boolean)
        ),
      ].slice(0, MAX_KINDS);
      patch.kinds = kinds;
      // Keep the legacy single field in step — the extraction template and
      // the pipeline progress bar both read it.
      patch.primaryKind = kinds[0];
      patch.kindSource = "human";

      // Register anything new so it becomes a pill for every other document.
      // upsert never overwrites an existing kind's extraction template.
      for (const name of kinds) {
        await ctx.runMutation(internal.kinds.upsert, {
          name,
          source: "human",
          templateRoles: [],
        });
      }
    }

    await ctx.db.patch(args.id, patch);
  },
});

/**
 * Add kinds to a document without disturbing the ones it already has.
 *
 * `updateIdentity` replaces the whole set, which is right for the identity
 * editor but wrong for tagging a selection: the documents in a selection rarely
 * share a kind list, and replacing would flatten them all to the same one.
 */
export const addKinds = mutation({
  args: { id: v.id("documents"), kinds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return;

    const existing = doc.kinds ?? (doc.primaryKind ? [doc.primaryKind] : []);
    const added = args.kinds
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    const kinds = [...new Set([...existing, ...added])].slice(0, MAX_KINDS);

    await ctx.db.patch(args.id, {
      kinds,
      primaryKind: kinds[0],
      kindSource: "human",
    });

    for (const name of added) {
      await ctx.runMutation(internal.kinds.upsert, {
        name,
        source: "human",
        templateRoles: [],
      });
    }
  },
});

export const getUrl = query({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

export const remove = mutation({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) return;

    // Delete the stored file(s) — web clips also carry a markdown article file.
    // Tolerate an already-missing file: throwing here would roll the whole
    // mutation back and leave the document permanently undeletable.
    for (const storageId of [doc.storageId, doc.textStorageId]) {
      if (!storageId) continue;
      try {
        await ctx.storage.delete(storageId);
      } catch {
        // already deleted
      }
    }

    // Delete related rows
    const pageTranslations = await ctx.db
      .query("pageTranslations")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const translation of pageTranslations) {
      await ctx.db.delete(translation._id);
    }

    const pages = await ctx.db
      .query("pages")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const page of pages) {
      // Delete blocks for this page
      const blocks = await ctx.db
        .query("blocks")
        .withIndex("by_page", (q) => q.eq("pageId", page._id))
        .collect();
      for (const block of blocks) await ctx.db.delete(block._id);
      await ctx.db.delete(page._id);
    }

    const extractions = await ctx.db
      .query("extractions")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const ext of extractions) await ctx.db.delete(ext._id);

    // Delete transcript segments (audio/video documents)
    const transcriptSegments = await ctx.db
      .query("transcriptSegments")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const seg of transcriptSegments) await ctx.db.delete(seg._id);

    const jobs = await ctx.db
      .query("processingJobs")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const job of jobs) await ctx.db.delete(job._id);

    // Delete relationships asserted by this document
    const docRels = await ctx.db
      .query("relationships")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const rel of docRels) await ctx.db.delete(rel._id);

    // Delete visual evidence detections for this document
    const docDetections = await ctx.db
      .query("detections")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const d of docDetections) await ctx.db.delete(d._id);

    // Delete this document's entity roles and merge suggestions raised from it
    const roles = await ctx.db
      .query("entityRoles")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const role of roles) await ctx.db.delete(role._id);

    const docSuggestions = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const s of docSuggestions) await ctx.db.delete(s._id);

    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();

    // Track affected entities to update their counts
    const affectedEntityIds = new Set(mentions.map((m) => m.entityId));

    for (const m of mentions) await ctx.db.delete(m._id);

    // Update entity counts and clean up orphaned entities
    for (const entityId of affectedEntityIds) {
      const entity = await ctx.db.get(entityId);
      if (!entity) continue;

      // Count remaining mentions and unique documents
      const remainingMentions = await ctx.db
        .query("mentions")
        .withIndex("by_entity", (q) => q.eq("entityId", entityId))
        .collect();

      if (remainingMentions.length === 0) {
        // No more mentions — delete relationships referencing this entity
        const sourceRels = await ctx.db
          .query("relationships")
          .withIndex("by_source", (q) => q.eq("sourceEntityId", entityId))
          .collect();
        for (const rel of sourceRels) await ctx.db.delete(rel._id);

        const targetRels = await ctx.db
          .query("relationships")
          .withIndex("by_target", (q) => q.eq("targetEntityId", entityId))
          .collect();
        for (const rel of targetRels) await ctx.db.delete(rel._id);

        // Drop merge suggestions pointing at this entity. Leaving them behind
        // would dangle (listPending hides them) while suggestionExists still
        // matched the pair, permanently suppressing a future legitimate
        // suggestion for a name that no longer exists.
        const asSuggestionSource = await ctx.db
          .query("mergeSuggestions")
          .withIndex("by_source_and_target", (q) =>
            q.eq("sourceEntityId", entityId)
          )
          .collect();
        for (const s of asSuggestionSource) await ctx.db.delete(s._id);

        const asSuggestionTarget = await ctx.db
          .query("mergeSuggestions")
          .withIndex("by_target", (q) => q.eq("targetEntityId", entityId))
          .collect();
        for (const s of asSuggestionTarget) await ctx.db.delete(s._id);

        // Delete the entity itself
        await ctx.db.delete(entityId);
      } else {
        const remainingDocs = new Set(
          remainingMentions.map((m) => m.documentId)
        );
        await ctx.db.patch(entityId, {
          mentionCount: remainingMentions.length,
          documentCount: remainingDocs.size,
        });
      }
    }

    // Delete research dossiers for this document
    const research = await ctx.db
      .query("research")
      .withIndex("by_document", (q) => q.eq("documentId", args.id))
      .collect();
    for (const r of research) await ctx.db.delete(r._id);

    // Delete the document itself
    await ctx.db.delete(args.id);
  },
});
