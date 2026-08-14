import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

/**
 * Convex's own auth provider list. The component derives the issuer and JWKS
 * from the deployment, so there is nothing to configure here by hand — and
 * `createAuth` in ./auth.ts feeds this same object to the `convex()` plugin so
 * the two can't drift.
 */
export default {
  providers: [getAuthConfigProvider()],
} satisfies AuthConfig;
