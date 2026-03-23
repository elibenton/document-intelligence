import { httpRouter } from "convex/server";

const http = httpRouter();

// Datalab uses polling (not webhooks) so we don't need HTTP callback routes
// for the pipeline. The Convex actions poll Datalab directly.
//
// Future: add webhook routes here if switching to async webhook mode.

export default http;
