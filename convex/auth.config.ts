import type { AuthConfig } from "convex/server";

// The fleet's production Clerk instance, as every Neorgon site with accounts
// (docs/architecture/auth-flow.md). The JWT template is named "convex" and
// carries aud: convex, which is what applicationID has to match.
const CLERK_JWT_ISSUER = "https://clerk.neorgon.com";

const providers: AuthConfig["providers"] = [{ domain: CLERK_JWT_ISSUER, applicationID: "convex" }];

// Dev sign-in (docs/CONTRACTS.md C9, A4, A7). A deployment trusts the dev
// issuer only when MUG_DEV_JWKS holds its public keys as a data: URI, which
// `node scripts/dev-auth.mjs jwks` prints. Convex insists that every variable
// this file reads is set, so production sets it to "off": anything but a
// data: URI adds no provider, and a dev token is refused there whoever holds
// the key.
const devJwks = process.env.MUG_DEV_JWKS || "";
if (devJwks.startsWith("data:")) {
  providers.push({
    type: "customJwt",
    issuer: "https://dev-auth.mug.invalid",
    jwks: devJwks,
    algorithm: "RS256",
    applicationID: "mug-dev",
  });
}

export default { providers } satisfies AuthConfig;
