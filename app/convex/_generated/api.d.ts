/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as documents from "../documents.js";
import type * as entities from "../entities.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as processing from "../processing.js";
import type * as processingJobs from "../processingJobs.js";
import type * as upload from "../upload.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  documents: typeof documents;
  entities: typeof entities;
  http: typeof http;
  ingest: typeof ingest;
  processing: typeof processing;
  processingJobs: typeof processingJobs;
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
