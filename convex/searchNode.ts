"use node";

/**
 * Deep search — Node-runtime half. The plan → retrieve → synthesize action
 * calls Interfaze, and the Interfaze SDK needs the Node runtime, so it lives
 * here under "use node". Every retrieval leg it drives (textLeg, entityLeg,
 * hydrate*, plannerContext) and the searches-table mutations stay in search.ts
 * on the default runtime and are reached by function reference.
 */

import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { SYNTHESIS_PAGES, VECTOR_LEG_HITS, type PageHit } from "./search";
import { chatCompletion } from "./interfaze";
import { usageLogger } from "./apiLogs";
import { healthReporter } from "./providerHealth";
import { embeddingsApiKey, embedTexts } from "./embeddings";


const PLAN_SCHEMA = {
  type: "object",
  properties: {
    keywords: {
      type: "string",
      description:
        "2-6 distinctive words for keyword (BM25) search over document text. Drop filler words; keep names, amounts, unusual terms.",
    },
    semantic_query: {
      type: "string",
      description:
        "A one-sentence description of the passage that would answer the question, for embedding similarity search.",
    },
    entity_names: {
      type: "array",
      items: { type: "string" },
      description:
        "Names from the KNOWN ENTITIES list that the question refers to (resolve pronouns/partial names to the listed form). Empty if none.",
    },
    roles: {
      type: "array",
      items: { type: "string" },
      description:
        "Roles from the KNOWN ROLES list the question implies (e.g. 'witness'). Empty if none.",
    },
    relation_types: {
      type: "array",
      items: { type: "string" },
      description:
        "Relation types from the KNOWN RELATION TYPES list the question implies (e.g. 'paid'). Empty if none.",
    },
  },
  required: ["keywords", "semantic_query", "entity_names", "roles", "relation_types"],
};


interface Plan {
  keywords: string;
  semantic_query: string;
  entity_names: string[];
  roles: string[];
  relation_types: string[];
}


// ---------------------------------------------------------------------------
// The deep search pipeline
// ---------------------------------------------------------------------------

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description:
        "Markdown answer to the question, grounded ONLY in the provided sources and known facts. Cite sources inline as [1], [2] ... matching the numbered source list. If the sources don't contain the answer, say so plainly.",
    },
  },
  required: ["answer"],
};


function rrfFuse(
  legs: Array<{ source: string; hits: PageHit[] }>,
  k = 60
): Array<{ key: string; hit: PageHit; score: number; sources: string[] }> {
  const fused = new Map<
    string,
    { hit: PageHit; score: number; sources: string[] }
  >();
  for (const leg of legs) {
    leg.hits.forEach((hit, rank) => {
      const key = `${hit.documentId}:${hit.pageNumber}`;
      const entry = fused.get(key);
      const inc = 1 / (k + rank + 1);
      if (entry) {
        entry.score += inc;
        if (!entry.sources.includes(leg.source)) entry.sources.push(leg.source);
        // Prefer a real text snippet over a mention/fact fallback
        if (leg.source === "text") entry.hit = hit;
      } else {
        fused.set(key, { hit, score: inc, sources: [leg.source] });
      }
    });
  }
  return [...fused.entries()]
    .map(([key, e]) => ({ key, ...e }))
    .sort((a, b) => b.score - a.score);
}


export const execute = internalAction({
  args: {
    searchId: v.id("searches"),
    query: v.string(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const interfazeKey = process.env.INTERFAZE_API_KEY;
    try {
      // ---- 1. Plan ------------------------------------------------------
      let plan: Plan = {
        keywords: args.query,
        semantic_query: args.query,
        entity_names: [],
        roles: [],
        relation_types: [],
      };
      if (interfazeKey) {
        try {
          const context: {
            entityNames: string[];
            roles: string[];
            relationTypes: string[];
            kinds: string[];
          } = await ctx.runQuery(internal.search.plannerContext, {
            projectId: args.projectId,
          });
          const { content } = await chatCompletion(interfazeKey, {
            usage: { log: usageLogger(ctx), operation: "search_plan" },
            systemPrompt:
              "You turn a user's question about a private document corpus into a structured retrieval plan. Only pick entity names, roles, and relation types that appear in the provided known lists — leave arrays empty rather than inventing values.",
            content: [
              {
                type: "text",
                text: [
                  `QUESTION: ${args.query}`,
                  ``,
                  `KNOWN ENTITIES:\n${context.entityNames.join("; ") || "(none)"}`,
                  ``,
                  `KNOWN ROLES:\n${context.roles.join("; ") || "(none)"}`,
                  ``,
                  `KNOWN RELATION TYPES:\n${context.relationTypes.join("; ") || "(none)"}`,
                  ``,
                  `DOCUMENT KINDS:\n${context.kinds.join("; ") || "(none)"}`,
                ].join("\n"),
              },
            ],
            responseSchema: { name: "retrieval_plan", schema: PLAN_SCHEMA },
            maxTokens: 1000,
          });
          const parsed = JSON.parse(content) as Partial<Plan>;
          plan = {
            keywords: parsed.keywords?.trim() || args.query,
            semantic_query: parsed.semantic_query?.trim() || args.query,
            entity_names: (parsed.entity_names ?? []).slice(0, 6),
            roles: (parsed.roles ?? []).slice(0, 6),
            relation_types: (parsed.relation_types ?? []).slice(0, 6),
          };
        } catch {
          // Planner failure is non-fatal — fall back to the raw query.
        }
      }
      await ctx.runMutation(internal.search.update, {
        searchId: args.searchId,
        status: "searching",
        plan: JSON.stringify(plan),
      });

      // ---- 2. Retrieve (three legs in parallel) --------------------------
      const geminiKey = embeddingsApiKey();
      const [textHits, vectorHits, entityResult] = await Promise.all([
        ctx.runQuery(internal.search.textLeg, {
          keywords: plan.keywords,
          queryText: args.query,
          projectId: args.projectId,
        }) as Promise<PageHit[]>,
        (async (): Promise<PageHit[]> => {
          if (!geminiKey) return [];
          try {
            const [vector] = await embedTexts([plan.semantic_query], geminiKey, {
              log: usageLogger(ctx),
              health: healthReporter(ctx),
            });
            const matches = await ctx.vectorSearch("pages", "by_embedding", {
              vector,
              limit: VECTOR_LEG_HITS,
              filter: (q) => q.eq("projectId", args.projectId),
            });
            return await ctx.runQuery(internal.search.hydratePageHits, {
              pageIds: matches.map((m) => m._id),
              queryText: args.query,
            });
          } catch {
            return []; // vector leg is best-effort
          }
        })(),
        ctx.runQuery(internal.search.entityLeg, {
          entityNames: plan.entity_names,
          roles: plan.roles,
          relationTypes: plan.relation_types,
          projectId: args.projectId,
        }) as Promise<{
          matchedEntities: Array<{
            entityId: Id<"entities">;
            name: string;
            type: string;
          }>;
          hits: PageHit[];
          facts: string[];
        }>,
      ]);

      const fused = rrfFuse([
        { source: "text", hits: textHits },
        { source: "semantic", hits: vectorHits },
        { source: "entity", hits: entityResult.hits },
      ]).slice(0, SYNTHESIS_PAGES);

      const hydrated: Array<{
        documentId: Id<"documents">;
        documentName: string;
        pageNumber: number;
        text: string;
      }> = await ctx.runQuery(internal.search.hydrateForSynthesis, {
        keys: fused.map((f) => ({
          documentId: f.hit.documentId,
          pageNumber: f.hit.pageNumber,
        })),
      });
      const nameByKey = new Map(
        hydrated.map((h) => [`${h.documentId}:${h.pageNumber}`, h.documentName])
      );

      const results = fused.map((f) => ({
        documentId: f.hit.documentId,
        documentName: nameByKey.get(f.key) ?? "Unknown document",
        pageNumber: f.hit.pageNumber,
        snippet: f.hit.snippet,
        score: f.score,
        sources: f.sources,
      }));

      await ctx.runMutation(internal.search.update, {
        searchId: args.searchId,
        status: "synthesizing",
        results,
        matchedEntities: entityResult.matchedEntities,
      });

      // ---- 3. Synthesize --------------------------------------------------
      let answer = "";
      if (interfazeKey && (hydrated.length > 0 || entityResult.facts.length > 0)) {
        const sourcesBlock = hydrated
          .map(
            (h, i) =>
              `[${i + 1}] "${h.documentName}", page ${h.pageNumber + 1}:\n${h.text}`
          )
          .join("\n\n");
        const factsBlock =
          entityResult.facts.length > 0
            ? `\n\nKNOWN FACTS (from the entity graph extracted across the corpus):\n- ${entityResult.facts.join("\n- ")}`
            : "";
        try {
          const { content } = await chatCompletion(interfazeKey, {
            usage: { log: usageLogger(ctx), operation: "search_answer" },
            systemPrompt:
              "You answer questions about a private document corpus. Ground every claim in the numbered sources or the known facts — cite sources inline as [n]. Never use outside knowledge. If the material doesn't answer the question, say what's missing.",
            content: [
              {
                type: "text",
                text: `QUESTION: ${args.query}\n\nSOURCES:\n${sourcesBlock}${factsBlock}`,
              },
            ],
            responseSchema: { name: "grounded_answer", schema: ANSWER_SCHEMA },
            reasoning: true,
            maxTokens: 2000,
          });
          answer = (JSON.parse(content) as { answer?: string }).answer ?? "";
        } catch {
          // Synthesis failure still leaves useful ranked results.
        }
      }

      await ctx.runMutation(internal.search.update, {
        searchId: args.searchId,
        status: "completed",
        answer:
          answer ||
          (results.length === 0
            ? "No matching content found in the corpus for this query."
            : ""),
      });
    } catch (e) {
      await ctx.runMutation(internal.search.update, {
        searchId: args.searchId,
        status: "failed",
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
