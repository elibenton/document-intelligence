import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { recountEntity } from "./entityResolution";
import { bumpDedupeCounter } from "./dedupeStats";
import { mergeEntities, pickSurvivor } from "./entityMerge";
import { authedMutation, authedQuery } from "./authz";
import {
  requireEntity,
  requireMergeLog,
  requireMergeSuggestion,
  requireProject,
} from "./ownership";

/**
 * Pending merge suggestions for one project, with both entities hydrated for
 * the review UI. One indexed read on the project's own rows — rows written
 * before projectId existed become visible after
 * migrations:backfillMergeSuggestionProjects runs.
 */
export const listPending = authedQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    const pending = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_project_and_status", (q) =>
        q.eq("projectId", args.projectId).eq("status", "pending")
      )
      .take(50);

    const results = [];
    for (const s of pending) {
      const source = await ctx.db.get(s.sourceEntityId);
      const target = await ctx.db.get(s.targetEntityId);
      if (!source || !target) continue;
      const doc = s.documentId ? await ctx.db.get(s.documentId) : null;
      results.push({
        _id: s._id,
        reason: s.reason,
        confidence: s.confidence ?? null,
        source: { _id: source._id, name: source.name, mentionCount: source.mentionCount },
        target: { _id: target._id, name: target.name, mentionCount: target.mentionCount },
        documentName: doc?.name ?? null,
      });
    }
    return results;
  },
});

/**
 * Pending suggestions touching one entity, for its page — the first reader
 * the by_target index ever had. Same hydrated shape as listPending so the
 * one review component serves both surfaces.
 */
export const forEntity = authedQuery({
  args: { entityId: v.id("entities") },
  handler: async (ctx, args) => {
    await requireEntity(ctx, args.entityId);
    const touching = [
      ...(await ctx.db
        .query("mergeSuggestions")
        .withIndex("by_source_and_target", (q) =>
          q.eq("sourceEntityId", args.entityId)
        )
        .collect()),
      ...(await ctx.db
        .query("mergeSuggestions")
        .withIndex("by_target", (q) => q.eq("targetEntityId", args.entityId))
        .collect()),
    ];
    const results = [];
    for (const s of touching) {
      if (s.status !== "pending") continue;
      const source = await ctx.db.get(s.sourceEntityId);
      const target = await ctx.db.get(s.targetEntityId);
      if (!source || !target) continue;
      const doc = s.documentId ? await ctx.db.get(s.documentId) : null;
      results.push({
        _id: s._id,
        reason: s.reason,
        confidence: s.confidence ?? null,
        source: { _id: source._id, name: source.name, mentionCount: source.mentionCount },
        target: { _id: target._id, name: target.name, mentionCount: target.mentionCount },
        documentName: doc?.name ?? null,
      });
    }
    return results;
  },
});

/**
 * Accept: fold one of the pair into the other. `keepEntityId` — set by the
 * confirm dialog's survivor picker — decides which name survives; without
 * it, pickSurvivor prefers the entity with more evidence, then the fuller
 * name (the old behavior always kept the *older* row, which folded "Eli
 * Cohen" into "E. Cohen" whenever the abbreviation arrived first). Returns
 * the mergeLog id so the UI can offer undo.
 */
export const accept = authedMutation({
  args: {
    id: v.id("mergeSuggestions"),
    keepEntityId: v.optional(v.id("entities")),
  },
  handler: async (ctx, args) => {
    await requireMergeSuggestion(ctx, args.id);
    const suggestion = await ctx.db.get(args.id);
    if (!suggestion || suggestion.status !== "pending") return null;
    const a = await ctx.db.get(suggestion.sourceEntityId);
    const b = await ctx.db.get(suggestion.targetEntityId);
    if (!a || !b) {
      await ctx.db.patch(args.id, { status: "rejected", resolvedAt: Date.now() });
      return null;
    }
    // Entities are per-project; folding one project's entity into another's
    // would drag its mentions and relationships across the boundary.
    if (a.projectId !== b.projectId) {
      await ctx.db.patch(args.id, { status: "rejected", resolvedAt: Date.now() });
      return null;
    }

    let target: typeof a;
    let source: typeof a;
    if (args.keepEntityId !== undefined) {
      if (args.keepEntityId !== a._id && args.keepEntityId !== b._id) {
        throw new Error("keepEntityId must be one of the suggested pair");
      }
      target = args.keepEntityId === a._id ? a : b;
      source = args.keepEntityId === a._id ? b : a;
    } else {
      target = pickSurvivor(a, b) === "a" ? a : b;
      source = target === a ? b : a;
    }

    const logId = await mergeEntities(ctx, {
      source,
      target,
      suggestionId: args.id,
    });
    await ctx.db.patch(args.id, { status: "accepted", resolvedAt: Date.now() });
    if (target.projectId) {
      await bumpDedupeCounter(ctx, target.projectId, "accepted");
    }
    return { mergeLogId: logId, survivorId: target._id };
  },
});


/**
 * Undo a merge from its log row — best-effort by declaration: rows the
 * deletion cascades have since taken are skipped, mentions attributed to
 * the target *after* the merge stay with it (there is no record they were
 * ever the source's), and a `partial` log refuses outright.
 */
export const unmerge = authedMutation({
  args: { logId: v.id("mergeLog") },
  handler: async (ctx, args) => {
    const log = await requireMergeLog(ctx, args.logId);
    if (log.undoneAt !== undefined) return null;
    if (log.partial) {
      throw new Error(
        "This merge moved too many rows to record fully and can't be undone"
      );
    }
    const target = await ctx.db.get(log.targetEntityId);
    if (!target) throw new Error("The merged entity no longer exists");

    // Restore the source with a fresh id; slug and name come back, so old
    // /entity/:slug links resolve again.
    const restoredId = await ctx.db.insert("entities", log.sourceSnapshot);

    for (const id of log.movedMentionIds) {
      const row = await ctx.db.get(id);
      if (row && row.entityId === log.targetEntityId) {
        await ctx.db.patch(id, { entityId: restoredId });
      }
    }
    for (const id of log.movedRoleIds) {
      const row = await ctx.db.get(id);
      if (row && row.entityId === log.targetEntityId) {
        await ctx.db.patch(id, { entityId: restoredId });
      }
    }
    for (const id of log.movedRelSourceIds) {
      const row = await ctx.db.get(id);
      if (row && row.sourceEntityId === log.targetEntityId) {
        await ctx.db.patch(id, { sourceEntityId: restoredId });
      }
    }
    for (const id of log.movedRelTargetIds) {
      const row = await ctx.db.get(id);
      if (row && row.targetEntityId === log.targetEntityId) {
        await ctx.db.patch(id, { targetEntityId: restoredId });
      }
    }
    for (const rel of log.deletedRelationships) {
      const { outgoing, ...fields } = rel;
      await ctx.db.insert("relationships", {
        ...fields,
        sourceEntityId: outgoing ? restoredId : log.targetEntityId,
        targetEntityId: outgoing ? log.targetEntityId : restoredId,
      });
    }

    // Strip what the merge taught the target.
    const removeAliases = new Set(log.aliasesAdded.map((s) => s.toLowerCase()));
    const removeTypes = new Set(log.typesAdded);
    await ctx.db.patch(log.targetEntityId, {
      aliases: target.aliases.filter(
        (alias) => !removeAliases.has(alias.toLowerCase())
      ),
      ...(target.types
        ? { types: target.types.filter((t) => !removeTypes.has(t)) }
        : {}),
      ...(log.starredWasSetByMerge ? { starred: undefined } : {}),
    });

    // The pair can be re-decided; a rejected flip would silence it forever.
    if (log.suggestionId) {
      const suggestion = await ctx.db.get(log.suggestionId);
      if (suggestion) {
        await ctx.db.patch(log.suggestionId, {
          status: "pending",
          resolvedAt: undefined,
        });
      }
    }

    await ctx.db.patch(args.logId, { undoneAt: Date.now() });
    await bumpDedupeCounter(ctx, log.projectId, "unmerges");
    await recountEntity(ctx, restoredId);
    await recountEntity(ctx, log.targetEntityId);
    return { restoredId };
  },
});

/**
 * Age out merge-undo detail: an undo window, not an archive. 30 days matches
 * apiLogs' retention and the UI's "undo available for 30 days" promise;
 * the durable record of how many merges happened is dedupeCounters.
 */
export const pruneOldMergeLogs = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    // Oldest-first by creation time, bounded: the table only ever holds a
    // month of merges, and expired rows sit at the front of the default
    // order, so one daily page clears the backlog.
    const old = await ctx.db.query("mergeLog").order("asc").take(500);
    for (const row of old) {
      if (row._creationTime < cutoff) await ctx.db.delete(row._id);
    }
    return null;
  },
});

/** Reject: keep both entities; remember the pair so it isn't re-suggested. */
export const reject = authedMutation({
  args: { id: v.id("mergeSuggestions") },
  handler: async (ctx, args) => {
    await requireMergeSuggestion(ctx, args.id);
    const suggestion = await ctx.db.get(args.id);
    if (!suggestion || suggestion.status !== "pending") return;
    await ctx.db.patch(args.id, { status: "rejected", resolvedAt: Date.now() });
    if (suggestion.projectId) {
      await bumpDedupeCounter(ctx, suggestion.projectId, "rejected");
    }
  },
});
