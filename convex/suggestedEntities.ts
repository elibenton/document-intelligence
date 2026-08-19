import { v } from "convex/values";
import { internal } from "./_generated/api";
import { authedAction } from "./authz";
import { analyzeDocumentText } from "./interfaze";
import { analyzeSystemPrompt } from "./analyzePrompt";
import { usageLogger } from "./apiLogs";
import { toKey } from "./projectEntityTypes";

/**
 * Run the extraction a suggested-entity chip offers: a text-in structured
 * call over the stored page text, extracting ONLY the chosen types, ingested
 * additively into this one document's graph. The types stay one-document —
 * they are deliberately not added to the project's declared vocabulary
 * (declaring a type for all future documents is the New Entity form's job).
 *
 * One call for however many chips were tapped: the UI batches selections
 * behind a short pause, so this takes the whole set at once.
 */
export const runExtraction = authedAction({
  args: {
    documentId: v.id("documents"),
    /** Labels of the document's stored suggestions to extract. */
    labels: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const document = await ctx.runQuery(internal.documents.getInternal, {
      id: args.documentId,
    });
    if (!document) throw new Error("Document not found");

    const wanted = new Set(args.labels.map((l) => l.toLowerCase()));
    const selected = (document.suggestedEntityTypes ?? []).filter((s) =>
      wanted.has(s.label.toLowerCase())
    );
    if (selected.length === 0) return null;

    const apiKey = process.env.INTERFAZE_API_KEY;
    if (!apiKey) throw new Error("INTERFAZE_API_KEY not configured");

    const pages: { pageNumber: number; text: string }[] = await ctx.runQuery(
      internal.pages.textByDocument,
      { documentId: args.documentId }
    );
    const pageTexts = pages
      .sort((a, b) => a.pageNumber - b.pageNumber)
      .map((page) => page.text);
    if (pageTexts.length === 0 || pageTexts.every((text) => !text.trim())) {
      throw new Error("No scanned text to extract from");
    }

    const types = selected.map((s) => ({ ...s, key: toKey(s.label) }));
    const prompt =
      "Extract every entity of the listed types from this document's text. " +
      "Work only from the text; never invent an entity. " +
      "Types: " +
      types.map((t) => `${t.key} — ${t.label}: ${t.description}`).join(" | ");
    const responseSchema = {
      name: "suggested_entity_extraction",
      schema: {
        type: "object",
        properties: {
          entities: {
            type: "array",
            description:
              "Every named entity of the listed types that the text names.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Entity name as written in the document",
                },
                type: {
                  type: "string",
                  enum: types.map((t) => t.key),
                },
              },
              required: ["name", "type"],
            },
          },
        },
        required: ["entities"],
      },
    };

    const result = await analyzeDocumentText(pageTexts, apiKey, {
      systemPrompt: analyzeSystemPrompt(false),
      prompt,
      responseSchema,
      log: usageLogger(ctx, { documentId: args.documentId }),
    });

    const parsed = JSON.parse(result.content) as {
      entities?: Array<{ name?: string; type?: string }>;
    };
    const validKeys = new Set(types.map((t) => t.key));
    const entities = (parsed.entities ?? [])
      .map((e) => ({
        name: (e.name ?? "").trim(),
        type: (e.type ?? "").trim(),
      }))
      .filter((e) => e.name && validKeys.has(e.type));

    await ctx.runMutation(internal.relationships.ingestAdditionalEntities, {
      documentId: args.documentId,
      entities,
    });

    // Consume the chips that ran; the rest stay on offer.
    await ctx.runMutation(internal.metadata.setSuggestedEntityTypes, {
      documentId: args.documentId,
      suggestions: (document.suggestedEntityTypes ?? []).filter(
        (s) => !wanted.has(s.label.toLowerCase())
      ),
    });
    return null;
  },
});
