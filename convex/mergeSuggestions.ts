import { v } from "convex/values";
import { recountEntity } from "./entityResolution";
import { authedMutation, authedQuery } from "./authz";

/**
 * Pending merge suggestions for one project, with both entities hydrated for
 * the review UI. Suggestion rows carry no projectId of their own, so the
 * project is taken from the entities they reference — over-fetch, then keep
 * this project's pairs. Without this every project's homepage listed every
 * other project's merges.
 */
export const listPending = authedQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(200);

    const results = [];
    for (const s of pending) {
      if (results.length >= 50) break;
      const source = await ctx.db.get(s.sourceEntityId);
      const target = await ctx.db.get(s.targetEntityId);
      if (!source || !target) continue;
      // Both endpoints must live in the project being viewed.
      if (
        source.projectId !== args.projectId ||
        target.projectId !== args.projectId
      ) {
        continue;
      }
      const doc = s.documentId ? await ctx.db.get(s.documentId) : null;
      results.push({
        _id: s._id,
        reason: s.reason,
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
    const suggestion = await ctx.db.get(args.id);
    if (!suggestion || suggestion.status !== "pending") return;
    const source = await ctx.db.get(suggestion.sourceEntityId);
    const target = await ctx.db.get(suggestion.targetEntityId);
    if (!source || !target) {
      await ctx.db.patch(args.id, { status: "rejected" });
      return;
    }
    // Entities are per-project; folding one project's entity into another's
    // would drag its mentions and relationships across the boundary.
    if (source.projectId !== target.projectId) {
      await ctx.db.patch(args.id, { status: "rejected" });
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

    // Retire any other pending suggestions touching the source entity
    const pending = await ctx.db
      .query("mergeSuggestions")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();
    for (const s of pending) {
      if (s._id === args.id) continue;
      if (s.sourceEntityId === source._id || s.targetEntityId === source._id) {
        await ctx.db.delete(s._id);
      }
    }

    await ctx.db.delete(source._id);
    await ctx.db.patch(args.id, { status: "accepted" });
    await recountEntity(ctx, target._id);
  },
});

/** Reject: keep both entities; remember the pair so it isn't re-suggested. */
export const reject = authedMutation({
  args: { id: v.id("mergeSuggestions") },
  handler: async (ctx, args) => {
    const suggestion = await ctx.db.get(args.id);
    if (!suggestion || suggestion.status !== "pending") return;
    await ctx.db.patch(args.id, { status: "rejected" });
  },
});
