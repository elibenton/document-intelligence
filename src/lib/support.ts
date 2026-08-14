/**
 * Where a user is told to write when they need something only the operator can
 * grant — more processing allowance, today.
 *
 * A constant rather than a `VITE_` variable: it ships in the client bundle
 * either way, so an env var would add a deploy-time failure mode (unset in one
 * environment, a `mailto:undefined` link in production) without hiding
 * anything. Change it here.
 */
export const SUPPORT_EMAIL = "eliunited@gmail.com";
