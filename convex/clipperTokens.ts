import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { authedMutation, authedQuery } from "./authz";
import { budgetFor } from "./budget";
import { requireProject } from "./ownership";

/**
 * Personal web-clipper tokens.
 *
 * The clipper extension cannot hold a Better Auth session, so it authenticates
 * to POST /clip with a bearer token minted here — the same bearer-secret idea
 * as convex/demo.ts, with the same justification: the argument is an
 * unguessable secret this server minted, and it reaches nothing but what its
 * owner already owns. The project choice lives on the token, not in the
 * extension: picking where clips land is a Settings action.
 *
 * One token per account. Re-minting replaces the old row, and deleting the
 * row is revocation — no revokedAt state to reason about.
 */

/** 32 random bytes, hex — same shape as demo session tokens. */
function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mint (or replace) the caller's clipper token, targeting a project they own.
 * No budget gate here — minting costs nothing; the gate runs at clip time.
 */
export const mint = authedMutation({
  args: { projectId: v.id("projects") },
  returns: v.string(),
  handler: async (ctx, args) => {
    await requireProject(ctx, args.projectId);
    const existing = await ctx.db
      .query("clipperTokens")
      .withIndex("by_owner", (q) => q.eq("ownerId", ctx.user._id))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    const token = mintToken();
    await ctx.db.insert("clipperTokens", {
      token,
      ownerId: ctx.user._id,
      projectId: args.projectId,
      createdAt: Date.now(),
    });
    return token;
  },
});

/**
 * The caller's token, shown on demand. Owner-gated by the builder, so
 * revealing it again is no wider than the mint that displayed it.
 */
export const mine = authedQuery({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      token: v.string(),
      projectId: v.id("projects"),
      createdAt: v.number(),
    })
  ),
  handler: async (ctx) => {
    const row = await ctx.db
      .query("clipperTokens")
      .withIndex("by_owner", (q) => q.eq("ownerId", ctx.user._id))
      .unique();
    return row
      ? { token: row.token, projectId: row.projectId, createdAt: row.createdAt }
      : null;
  },
});

export const revoke = authedMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const row = await ctx.db
      .query("clipperTokens")
      .withIndex("by_owner", (q) => q.eq("ownerId", ctx.user._id))
      .unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

/**
 * Resolve a bearer token for POST /clip, before any bytes are stored.
 *
 * Returns null for an unknown token, or one whose target project has been
 * deleted or changed hands — one opaque failure, for the oracle reason in
 * convex/ownership.ts. `exhausted` rides along so the endpoint can refuse an
 * out-of-budget account with 402 before storing the clip's blobs;
 * clips.createFromClip re-verifies ownership at write time.
 */
export const resolve = internalQuery({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      ownerId: v.string(),
      projectId: v.id("projects"),
      exhausted: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    if (!args.token) return null;
    const row = await ctx.db
      .query("clipperTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (!row) return null;
    const project = await ctx.db.get(row.projectId);
    if (!project || project.ownerId !== row.ownerId) return null;
    const budget = await budgetFor(ctx, row.ownerId);
    return {
      ownerId: row.ownerId,
      projectId: row.projectId,
      exhausted: budget.exhausted,
    };
  },
});
