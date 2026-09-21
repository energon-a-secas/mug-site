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
import type * as catalog from "../catalog.js";
import type * as community from "../community.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as images from "../images.js";
import type * as importer from "../importer.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_admin from "../lib/admin.js";
import type * as lib_cards from "../lib/cards.js";
import type * as lib_catalogue from "../lib/catalogue.js";
import type * as lib_counters from "../lib/counters.js";
import type * as lib_fallbackFetch from "../lib/fallbackFetch.js";
import type * as lib_handles from "../lib/handles.js";
import type * as lib_images from "../lib/images.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_listing from "../lib/listing.js";
import type * as lib_matchCore from "../lib/matchCore.js";
import type * as lib_mugCore from "../lib/mugCore.js";
import type * as lib_profilesCore from "../lib/profilesCore.js";
import type * as lib_proxy from "../lib/proxy.js";
import type * as lib_rate from "../lib/rate.js";
import type * as lib_result from "../lib/result.js";
import type * as lib_reviewCore from "../lib/reviewCore.js";
import type * as lib_shelfCore from "../lib/shelfCore.js";
import type * as lib_stageCore from "../lib/stageCore.js";
import type * as lib_tokens from "../lib/tokens.js";
import type * as lib_util from "../lib/util.js";
import type * as maintenance from "../maintenance.js";
import type * as moderation from "../moderation.js";
import type * as mugs from "../mugs.js";
import type * as photos from "../photos.js";
import type * as profiles from "../profiles.js";
import type * as runner from "../runner.js";
import type * as runnerTokens from "../runnerTokens.js";
import type * as runs from "../runs.js";
import type * as scan from "../scan.js";
import type * as seed from "../seed.js";
import type * as shelf from "../shelf.js";
import type * as sources from "../sources.js";
import type * as staging from "../staging.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  catalog: typeof catalog;
  community: typeof community;
  crons: typeof crons;
  http: typeof http;
  images: typeof images;
  importer: typeof importer;
  "lib/access": typeof lib_access;
  "lib/admin": typeof lib_admin;
  "lib/cards": typeof lib_cards;
  "lib/catalogue": typeof lib_catalogue;
  "lib/counters": typeof lib_counters;
  "lib/fallbackFetch": typeof lib_fallbackFetch;
  "lib/handles": typeof lib_handles;
  "lib/images": typeof lib_images;
  "lib/limits": typeof lib_limits;
  "lib/listing": typeof lib_listing;
  "lib/matchCore": typeof lib_matchCore;
  "lib/mugCore": typeof lib_mugCore;
  "lib/profilesCore": typeof lib_profilesCore;
  "lib/proxy": typeof lib_proxy;
  "lib/rate": typeof lib_rate;
  "lib/result": typeof lib_result;
  "lib/reviewCore": typeof lib_reviewCore;
  "lib/shelfCore": typeof lib_shelfCore;
  "lib/stageCore": typeof lib_stageCore;
  "lib/tokens": typeof lib_tokens;
  "lib/util": typeof lib_util;
  maintenance: typeof maintenance;
  moderation: typeof moderation;
  mugs: typeof mugs;
  photos: typeof photos;
  profiles: typeof profiles;
  runner: typeof runner;
  runnerTokens: typeof runnerTokens;
  runs: typeof runs;
  scan: typeof scan;
  seed: typeof seed;
  shelf: typeof shelf;
  sources: typeof sources;
  staging: typeof staging;
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
