import { defineApp } from "convex/server";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import workpool from "@convex-dev/workpool/convex.config.js";

const app = defineApp();

app.use(workpool, { name: "processingWorkpool" });
app.use(staticHosting);

export default app;
