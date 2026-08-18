import { v } from "convex/values";
import { recountEntity } from "./entityResolution";
import { bumpDedupeCounter } from "./dedupeStats";
import { authedMutation, authedQuery } from "./authz";
import { requireMergeSuggestion, requireProject } from "./ownership";

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
 * Accept: fold the source entity into the target — move mentions, roles, and
 * relationships; teach the source name (and its aliases) as target aliases;
 * merge stable types; delete the source.
 */
export const accept = authedMutation({
  args: { id: v.id("mergeSuggestions") },
  handler: async (ctx, args) => {
    await requireMergeSuggestion(ctx, args.id);
    const suggestion = await ctx.db.get(args.id);
    if (!suggestion || suggestion.status !== "pending") return;
    const source = await ctx.db.get(suggestion.sourceEntityId);
    const target = await ctx.db.get(suggestion.targetEntityId);
    if (!source || !target) {
      await ctx.db.patch(args.id, { status: "rejected", resolvedAt: Date.now() });
      return;
    }
    // Entities are per-project; folding one project's entity into another's
    // would drag its mentions and relationships across the boundary.
    if (source.projectId !== target.projectId) {
      await ctx.db.patch(args.id, { status: "rejected", resolvedAt: Date.now() });
      return;
    }

    // Move mentions
    const mentions = await ctx.db
      .query("mentions")
      .withIndex("by_entity", (q) => q.eq("entityId", source._id))
      .collect();
    for (const m of mentions) {
      await ctx.db.patch(m._id, { entityId: target._id });
    }

    // Move roles, skipping duplicates already on the target
    const roles = await ctx.db
      .query("entityRoles")
      .withIndex("by_entity", (q) => q.eq("entityId", source._id))
      .collect();
    for (const r of roles) {
      const dup = await ctx.db
        .query("entityRoles")
        .withIndex("by_entity_and_document", (q) =>
          q.eq("entityId", target._id).eq("documentId", r.documentId)
        )
        .collect();
      if (dup.some((d) => d.role === r.role)) {
        await ctx.db.delete(r._id);
      } else {
        await ctx.db.patch(r._id, { entityId: target._id });
      }
    }

    // Move relationships (both directions); drop any that become self-loops
    const asSource = await ctx.db
      .query("relationships")
      .withIndex("by_source", (q) => q.eq("sourceEntityId", source._id))
      .collect();
    for (const rel of asSource) {
      if (rel.targetEntityId === target._id) await ctx.db.delete(rel._id);
      else await ctx.db.patch(rel._id, { sourceEntityId: target._id });
    }
    const asTarget = await ctx.db
      .query("relationships")
      .withIndex("by_target", (q) => q.eq("targetEntityId", source._id))
      .collect();
    for (const rel of asTarget) {
      if (rel.sourceEntityId === target._id) await ctx.db.delete(rel._id);
      else await ctx.db.patch(rel._id, { targetEntityId: target._id });
    }

    // Teach aliases + merge stable types
    const aliasSet = new Set(target.aliases.map((a) => a.toLowerCase()));
    aliasSet.add(target.name.toLowerCase());
    const newAliases = [...target.aliases];
    for (const candidate of [source.name, ...source.aliases]) {
      if (!aliasSet.has(candidate.toLowerCase())) {
        aliasSet.add(candidate.toLowerCase());
        newAliases.push(candidate);
      }
    }
    const typeSet = new Set([...(target.types ?? []), ...(source.types ?? [])]);
    await ctx.db.patch(target._id, {
      aliases: newAliases,
      ...(typeSet.size > 0 ? { types: [...typeSet] } : {}),
      // A user's pin belongs to the real-world entity, not whichever duplicate
      // record happens to survive the merge.
      ...(source.starred || target.starred ? { starred: true } : {}),
    });

    // Retire any other pending suggestions touching the source entity —
    // superseded rather than deleted, so accept/reject rates stay measurable.
    // Bounded by the entity's own suggestions instead of the old
    // deployment-wide pending scan.
    const touching = [
      ...(await ctx.db
        .query("mergeSuggestions")
        .withIndex("by_source_and_target", (q) =>
          q.eq("sourceEntityId", source._id)
        )
        .collect()),
      ...(await ctx.db
        .query("mergeSuggestions")
        .withIndex("by_target", (q) => q.eq("targetEntityId", source._id))
        .collect()),
    ];
    for (const s of touching) {
      if (s._id === args.id || s.status !== "pending") continue;
      await ctx.db.patch(s._id, {
        status: "superseded",
        resolvedAt: Date.now(),
      });
    }

    await ctx.db.delete(source._id);
    await ctx.db.patch(args.id, { status: "accepted", resolvedAt: Date.now() });
    if (target.projectId) {
      await bumpDedupeCounter(ctx, target.projectId, "accepted");
    }
    await recountEntity(ctx, target._id);
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
