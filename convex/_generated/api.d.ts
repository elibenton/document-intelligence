/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as analyzePrompt from "../analyzePrompt.js";
import type * as annotations from "../annotations.js";
import type * as apiLogs from "../apiLogs.js";
import type * as auth from "../auth.js";
import type * as authz from "../authz.js";
import type * as blocks from "../blocks.js";
import type * as clips from "../clips.js";
import type * as crons from "../crons.js";
import type * as detections from "../detections.js";
import type * as documentCategories from "../documentCategories.js";
import type * as documentMove from "../documentMove.js";
import type * as documents from "../documents.js";
import type * as docx from "../docx.js";
import type * as docxRender from "../docxRender.js";
import type * as embeddings from "../embeddings.js";
import type * as entities from "../entities.js";
import type * as entityResolution from "../entityResolution.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as interfaze from "../interfaze.js";
import type * as interfazeCost from "../interfazeCost.js";
import type * as interfazeErrors from "../interfazeErrors.js";
import type * as interfazeLimits from "../interfazeLimits.js";
import type * as interfazeOcr from "../interfazeOcr.js";
import type * as kinds from "../kinds.js";
import type * as mergeSuggestions from "../mergeSuggestions.js";
import type * as metadata from "../metadata.js";
import type * as migrations from "../migrations.js";
import type * as ocrChecks from "../ocrChecks.js";
import type * as ownership from "../ownership.js";
import type * as pageImages from "../pageImages.js";
import type * as pages from "../pages.js";
import type * as processing from "../processing.js";
import type * as processingControl from "../processingControl.js";
import type * as processingJobs from "../processingJobs.js";
import type * as processingNode from "../processingNode.js";
import type * as processingPool from "../processingPool.js";
import type * as projectEntityTypes from "../projectEntityTypes.js";
import type * as projectTemplates from "../projectTemplates.js";
import type * as projectViews from "../projectViews.js";
import type * as projects from "../projects.js";
import type * as providerHealth from "../providerHealth.js";
import type * as relationTypes from "../relationTypes.js";
import type * as relationships from "../relationships.js";
import type * as relationshipsNode from "../relationshipsNode.js";
import type * as rename from "../rename.js";
import type * as renameNode from "../renameNode.js";
import type * as renderPages from "../renderPages.js";
import type * as renderPool from "../renderPool.js";
import type * as rendererConfig from "../rendererConfig.js";
import type * as roles from "../roles.js";
import type * as search from "../search.js";
import type * as searchNode from "../searchNode.js";
import type * as settings from "../settings.js";
import type * as slug from "../slug.js";
import type * as transcripts from "../transcripts.js";
import type * as translationNode from "../translationNode.js";
import type * as translations from "../translations.js";
import type * as upload from "../upload.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  analyzePrompt: typeof analyzePrompt;
  annotations: typeof annotations;
  apiLogs: typeof apiLogs;
  auth: typeof auth;
  authz: typeof authz;
  blocks: typeof blocks;
  clips: typeof clips;
  crons: typeof crons;
  detections: typeof detections;
  documentCategories: typeof documentCategories;
  documentMove: typeof documentMove;
  documents: typeof documents;
  docx: typeof docx;
  docxRender: typeof docxRender;
  embeddings: typeof embeddings;
  entities: typeof entities;
  entityResolution: typeof entityResolution;
  http: typeof http;
  ingest: typeof ingest;
  interfaze: typeof interfaze;
  interfazeCost: typeof interfazeCost;
  interfazeErrors: typeof interfazeErrors;
  interfazeLimits: typeof interfazeLimits;
  interfazeOcr: typeof interfazeOcr;
  kinds: typeof kinds;
  mergeSuggestions: typeof mergeSuggestions;
  metadata: typeof metadata;
  migrations: typeof migrations;
  ocrChecks: typeof ocrChecks;
  ownership: typeof ownership;
  pageImages: typeof pageImages;
  pages: typeof pages;
  processing: typeof processing;
  processingControl: typeof processingControl;
  processingJobs: typeof processingJobs;
  processingNode: typeof processingNode;
  processingPool: typeof processingPool;
  projectEntityTypes: typeof projectEntityTypes;
  projectTemplates: typeof projectTemplates;
  projectViews: typeof projectViews;
  projects: typeof projects;
  providerHealth: typeof providerHealth;
  relationTypes: typeof relationTypes;
  relationships: typeof relationships;
  relationshipsNode: typeof relationshipsNode;
  rename: typeof rename;
  renameNode: typeof renameNode;
  renderPages: typeof renderPages;
  renderPool: typeof renderPool;
  rendererConfig: typeof rendererConfig;
  roles: typeof roles;
  search: typeof search;
  searchNode: typeof searchNode;
  settings: typeof settings;
  slug: typeof slug;
  transcripts: typeof transcripts;
  translationNode: typeof translationNode;
  translations: typeof translations;
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

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  processingWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"processingWorkpool">;
  renderWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"renderWorkpool">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
