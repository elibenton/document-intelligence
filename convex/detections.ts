import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { authedQuery } from "./authz";
import { requireDocument } from "./ownership";

// Visual evidence on document pages — signatures, stamps, redactions,
// handwriting — stored for the viewer's page overlays and its Visual Evidence
// list.
//
// NOTHING WRITES THIS TABLE TODAY. `saveDetections` has no caller: the values
// came out of the whole-document full-model completion removed in favour of
// `task: "ocr"` (see the REMOVED note in `interfaze.ts`), and the OCR task
// returns no visual objects. `byDocument` is live and 18 documents still carry
// 193 rows from before the switch, so this is a half-alive feature, not dead
// code — deleting the table would destroy real data that the viewer renders.
//
// Restoring the write side is a product decision, not a wiring job, because the
// obvious replacement is worse than what it replaces:
//
//   - `task: "object_detection"` returns `{ bounds, label }` per object and
//     nothing else — no `description` (the entire body of each row in the UI's
//     Visual Evidence list) and no `confidence`. Both are required here.
//   - It returns one flat list for the whole file with pixel bounds and no page
//     number, so page attribution would have to be inferred from stacked
//     coordinates — the same guessing `ocrPrecontextToPages` already does, and
//     the part of the OCR path with the worst regression history. There are no
//     server-side page rasters to detect against per page; `pageImages` renders
//     text geometry only.
//   - The full-model completion that produced these rows measured $0.18/doc
//     against $0.012 for the OCR task, which is why it was removed.
//
// Do not delete this and do not wire in the task without deciding which of
// those costs is acceptable.

export const saveDetections = internalMutation({
  args: {
    documentId: v.id("documents"),
    detections: v.array(
      v.object({
        pageNumber: v.number(),
        label: v.string(),
        description: v.string(),
        confidence: v.number(),
        bbox: v.optional(
          v.object({
            x: v.number(),
            y: v.number(),
            width: v.number(),
            height: v.number(),
          })
        ),
      })
    ),
  },
  handler: async (ctx, args) => {
    // Re-run safety: replace this document's detections
    const existing = await ctx.db
      .query("detections")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const d of existing) await ctx.db.delete(d._id);

    for (const d of args.detections) {
      await ctx.db.insert("detections", {
        documentId: args.documentId,
        ...d,
      });
    }
  },
});

export const byDocument = authedQuery({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    await requireDocument(ctx, args.documentId);
    return await ctx.db
      .query("detections")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .take(200);
  },
});
