/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as blocks from "../blocks.js";
import type * as datalab from "../datalab.js";
import type * as documents from "../documents.js";
import type * as entities from "../entities.js";
import type * as extractions from "../extractions.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as pages from "../pages.js";
import type * as processing from "../processing.js";
import type * as processingJobs from "../processingJobs.js";
import type * as research from "../research.js";
import type * as researchQueries from "../researchQueries.js";
import type * as stories from "../stories.js";
import type * as upload from "../upload.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  blocks: typeof blocks;
  datalab: typeof datalab;
  documents: typeof documents;
  entities: typeof entities;
  extractions: typeof extractions;
  http: typeof http;
  ingest: typeof ingest;
  pages: typeof pages;
  processing: typeof processing;
  processingJobs: typeof processingJobs;
  research: typeof research;
  researchQueries: typeof researchQueries;
  stories: typeof stories;
  upload: typeof upload;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
