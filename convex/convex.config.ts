import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import workpool from "@convex-dev/workpool/convex.config.js";

const app = defineApp();

app.use(workpool, { name: "processingWorkpool" });
// Rendering is deliberately independent of AI processing, so it gets its own
// pool: page derivatives must never wait behind an Interfaze queue, and unlike
// Interfaze calls a rasterization retry is free and idempotent.
app.use(workpool, { name: "renderWorkpool" });
app.use(staticHosting);

export default app;
