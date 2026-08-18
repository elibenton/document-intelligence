import { authedQuery } from "./authz";

/**
 * The caller's speaker library, most recently used first. The whole set
 * ships and the autocomplete filters client-side: the library is small
 * (people a user records with), so a per-keystroke server search would be
 * the "plaintext title search" mistake in reverse.
 */
export const list = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("speakers")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .order("desc")
      .take(200);
    return rows.map((row) => ({
      _id: row._id,
      name: row.name,
      useCount: row.useCount,
    }));
  },
});
