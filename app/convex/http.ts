import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/ingest/ocr",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    await ctx.runMutation(internal.ingest.ingestOcrResults, {
      documentId: body.documentId,
      pages: body.pages,
    });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

http.route({
  path: "/ingest/ner",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    await ctx.runMutation(internal.ingest.ingestNerResults, {
      documentId: body.documentId,
      entities: body.entities,
    });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

export default http;
