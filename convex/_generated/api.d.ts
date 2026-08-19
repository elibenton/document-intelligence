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
import type * as budget from "../budget.js";
import type * as clipperTokens from "../clipperTokens.js";
import type * as clips from "../clips.js";
import type * as crons from "../crons.js";
import type * as dedupeStats from "../dedupeStats.js";
import type * as demo from "../demo.js";
import type * as demoLimits from "../demoLimits.js";
import type * as detections from "../detections.js";
import type * as documentCategories from "../documentCategories.js";
import type * as documentMove from "../documentMove.js";
import type * as documentSpeakers from "../documentSpeakers.js";
import type * as documents from "../documents.js";
import type * as embeddings from "../embeddings.js";
import type * as entities from "../entities.js";
import type * as entityMerge from "../entityMerge.js";
import type * as entityResolution from "../entityResolution.js";
import type * as entitySweep from "../entitySweep.js";
import type * as hash from "../hash.js";
import type * as http from "../http.js";
import type * as ingest from "../ingest.js";
import type * as interfaze from "../interfaze.js";
import type * as interfazeCost from "../interfazeCost.js";
import type * as interfazeErrors from "../interfazeErrors.js";
import type * as interfazeLimits from "../interfazeLimits.js";
import type * as interfazeOcr from "../interfazeOcr.js";
import type * as interfazeStt from "../interfazeStt.js";
import type * as issueFingerprint from "../issueFingerprint.js";
import type * as issueState from "../issueState.js";
import type * as issues from "../issues.js";
import type * as kinds from "../kinds.js";
import type * as mediaTypes from "../mediaTypes.js";
import type * as mergeSuggestions from "../mergeSuggestions.js";
import type * as metadata from "../metadata.js";
import type * as migrations from "../migrations.js";
import type * as nameMatch from "../nameMatch.js";
import type * as nativeText from "../nativeText.js";
import type * as ocrChecks from "../ocrChecks.js";
import type * as ownership from "../ownership.js";
import type * as pages from "../pages.js";
import type * as pdfNativeMetadata from "../pdfNativeMetadata.js";
import type * as processing from "../processing.js";
import type * as processingControl from "../processingControl.js";
import type * as processingJobs from "../processingJobs.js";
import type * as processingStages from "../processingStages.js";
import type * as projectEntityTypes from "../projectEntityTypes.js";
import type * as projectTemplates from "../projectTemplates.js";
import type * as projectViews from "../projectViews.js";
import type * as projects from "../projects.js";
import type * as providerHealth from "../providerHealth.js";
import type * as relationTypes from "../relationTypes.js";
import type * as relationships from "../relationships.js";
import type * as rename from "../rename.js";
import type * as roles from "../roles.js";
import type * as search from "../search.js";
import type * as settings from "../settings.js";
import type * as slug from "../slug.js";
import type * as speakerSignature from "../speakerSignature.js";
import type * as speakers from "../speakers.js";
import type * as suggestedEntities from "../suggestedEntities.js";
import type * as transcripts from "../transcripts.js";
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
  budget: typeof budget;
  clipperTokens: typeof clipperTokens;
  clips: typeof clips;
  crons: typeof crons;
  dedupeStats: typeof dedupeStats;
  demo: typeof demo;
  demoLimits: typeof demoLimits;
  detections: typeof detections;
  documentCategories: typeof documentCategories;
  documentMove: typeof documentMove;
  documentSpeakers: typeof documentSpeakers;
  documents: typeof documents;
  embeddings: typeof embeddings;
  entities: typeof entities;
  entityMerge: typeof entityMerge;
  entityResolution: typeof entityResolution;
  entitySweep: typeof entitySweep;
  hash: typeof hash;
  http: typeof http;
  ingest: typeof ingest;
  interfaze: typeof interfaze;
  interfazeCost: typeof interfazeCost;
  interfazeErrors: typeof interfazeErrors;
  interfazeLimits: typeof interfazeLimits;
  interfazeOcr: typeof interfazeOcr;
  interfazeStt: typeof interfazeStt;
  issueFingerprint: typeof issueFingerprint;
  issueState: typeof issueState;
  issues: typeof issues;
  kinds: typeof kinds;
  mediaTypes: typeof mediaTypes;
  mergeSuggestions: typeof mergeSuggestions;
  metadata: typeof metadata;
  migrations: typeof migrations;
  nameMatch: typeof nameMatch;
  nativeText: typeof nativeText;
  ocrChecks: typeof ocrChecks;
  ownership: typeof ownership;
  pages: typeof pages;
  pdfNativeMetadata: typeof pdfNativeMetadata;
  processing: typeof processing;
  processingControl: typeof processingControl;
  processingJobs: typeof processingJobs;
  processingStages: typeof processingStages;
  projectEntityTypes: typeof projectEntityTypes;
  projectTemplates: typeof projectTemplates;
  projectViews: typeof projectViews;
  projects: typeof projects;
  providerHealth: typeof providerHealth;
  relationTypes: typeof relationTypes;
  relationships: typeof relationships;
  rename: typeof rename;
  roles: typeof roles;
  search: typeof search;
  settings: typeof settings;
  slug: typeof slug;
  speakerSignature: typeof speakerSignature;
  speakers: typeof speakers;
  suggestedEntities: typeof suggestedEntities;
  transcripts: typeof transcripts;
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
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
