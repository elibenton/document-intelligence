"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// ---------------------------------------------------------------------------
// Structured JSON schema for Perplexity Sonar response_format
// ---------------------------------------------------------------------------

const DOSSIER_SCHEMA = {
  type: "object" as const,
  properties: {
    bio: {
      type: "object" as const,
      properties: {
        full_name: {
          type: "string" as const,
          description:
            "Full legal name. 'Unknown' if not certain.",
        },
        occupation: {
          type: "string" as const,
          description:
            "Primary occupation or profession. 'Unknown' if not certain.",
        },
        title: {
          type: "string" as const,
          description:
            "Current or most recent professional title. 'Unknown' if not certain.",
        },
        organization: {
          type: "string" as const,
          description:
            "Current or most recent organization/employer. 'Unknown' if not certain.",
        },
        location: {
          type: "string" as const,
          description:
            "City, State/Country. 'Unknown' if not certain.",
        },
      },
      required: [
        "full_name",
        "occupation",
        "title",
        "organization",
        "location",
      ],
    },
    contact: {
      type: "object" as const,
      properties: {
        email: {
          type: "string" as const,
          description:
            "Publicly available email address. 'Unknown' if not found in public sources.",
        },
        phone: {
          type: "string" as const,
          description:
            "Publicly available phone number. 'Unknown' if not found in public sources.",
        },
        website: {
          type: "string" as const,
          description:
            "Personal or professional website URL. 'Unknown' if not found.",
        },
        social_profiles: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "LinkedIn, Twitter/X, GitHub, or other confirmed social profile URLs.",
        },
      },
      required: ["email", "phone"],
    },
    summary: {
      type: "string" as const,
      description:
        "1-2 sentence summary of who/what this entity is.",
    },
    key_facts: {
      type: "array" as const,
      items: { type: "string" as const },
      description:
        "Important details, background, career history, and context. Each fact is a concise sentence.",
    },
    recent_activity: {
      type: "array" as const,
      items: { type: "string" as const },
      description:
        "Recent news, developments, or public activity. Each item is a concise sentence.",
    },
    connections: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          relationship: {
            type: "string" as const,
            description:
              "How they are connected (e.g. 'Co-founder at X', 'Reported to', 'Legal counsel').",
          },
        },
        required: ["name", "relationship"],
      },
      description:
        "Notable relationships, affiliations, or associations.",
    },
  },
  required: [
    "bio",
    "contact",
    "summary",
    "key_facts",
    "recent_activity",
    "connections",
  ],
};

// ---------------------------------------------------------------------------
// Action: run Perplexity Sonar research on an entity
// ---------------------------------------------------------------------------

export const runResearch = action({
  args: {
    documentId: v.id("documents"),
    entityName: v.string(),
    entityType: v.optional(v.string()),
    documentContext: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const apiKey = process.env.PERPLEXITY_API_KEY;
    if (!apiKey) throw new Error("PERPLEXITY_API_KEY not configured");

    const model = "sonar-pro";

    const contextClause = args.documentContext
      ? `\n\nThis entity appears in a document with the following context:\n"${args.documentContext}"`
      : "";

    const typeHint = args.entityType ? ` (${args.entityType})` : "";

    const systemPrompt = `You are a research assistant compiling a structured intelligence dossier. Be factual and precise. Only include information you are confident about — use "Unknown" for anything uncertain. Focus on the most relevant and recent information.`;

    const userPrompt = `Research "${args.entityName}"${typeHint} and return a structured dossier with bio, contact info, summary, key facts, recent activity, and connections.${contextClause}`;

    // Create pending record
    const researchId = await ctx.runMutation(
      internal.researchQueries.createPending,
      {
        documentId: args.documentId,
        entityName: args.entityName,
        query: userPrompt,
        model,
      }
    );

    try {
      const response = await fetch(
        "https://api.perplexity.ai/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            max_tokens: 2048,
            response_format: {
              type: "json_schema",
              json_schema: {
                schema: DOSSIER_SCHEMA,
              },
            },
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Perplexity API error (${response.status}): ${errorText}`
        );
      }

      const data = await response.json();

      // Content is now structured JSON, store it as-is
      const content = data.choices?.[0]?.message?.content ?? "";
      const citations: string[] = data.citations ?? [];
      const rawSearchResults = data.search_results ?? [];

      const searchResults = rawSearchResults.map(
        (r: { title?: string; url?: string; snippet?: string }) => ({
          title: r.title ?? "",
          url: r.url ?? "",
          snippet: r.snippet ?? "",
        })
      );

      await ctx.runMutation(internal.researchQueries.saveResult, {
        researchId,
        content,
        citations,
        searchResults,
        status: "completed",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.researchQueries.saveResult, {
        researchId,
        content: "",
        citations: [],
        status: "failed",
        errorMessage: msg,
      });
    }
  },
});
