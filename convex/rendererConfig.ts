/**
 * Increment whenever page derivatives or native text geometry need a
 * deterministic backfill. Existing rasters are reused; only outdated pages
 * are reopened with PDF.js and upgraded in place.
 */
export const RENDERER_VERSION = 4;
