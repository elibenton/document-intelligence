/**
 * Rename pass — default-runtime half.
 *
 * The Interfaze call (runRenamePass / runRename) lives in renameNode.ts under
 * "use node" because the Interfaze SDK needs the Node runtime. This file keeps
 * the mutation that persists the chosen title.
 *
 * The result lands in `documents.displayName`. The uploaded `name` is never
 * touched: it's provenance, it's what the user recognizes in their own
 * filesystem, and the UI keeps showing it underneath the new title.
 */

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const saveDisplayName = internalMutation({
  args: {
    documentId: v.id("documents"),
    displayName: v.string(),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) return;
    // A title identical to the filename is noise: the UI would render the same
    // string twice, once as the AI title and once as the original beneath it.
    if (args.displayName === document.name) return;
    // A title the user typed outranks anything this pass comes up with.
    if (document.displayNameSource === "human") return;
    await ctx.db.patch(args.documentId, {
      displayName: args.displayName,
      displayNameSource: "ai",
    });
  },
});
