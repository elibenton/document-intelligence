import { defineApp } from "convex/server";
import betterAuth from "@convex-dev/better-auth/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import workpool from "@convex-dev/workpool/convex.config.js";

const app = defineApp();

app.use(betterAuth);

app.use(workpool, { name: "processingWorkpool" });
// Background enrichment gets its own pool so that work nobody is waiting on
// can never delay work someone is watching. See convex/enrichmentPool.ts.
app.use(workpool, { name: "enrichmentWorkpool" });
// Rendering is deliberately independent of AI processing, so it gets its own
// pool: page derivatives must never wait behind an Interfaze queue, and unlike
// Interfaze calls a rasterization retry is free and idempotent.
app.use(workpool, { name: "renderWorkpool" });
app.use(staticHosting);

export default app;
