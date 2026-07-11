import type { OAuthEnvKeys, OAuthTokens } from "./types.js";

/**
 * Refresh when within this many ms of expiry, so tokens do not lapse mid-run.
 */
export const OAUTH_REFRESH_THRESHOLD_MS = 60_000;

/**
 * Serializes tokens onto the provider's env keys (email/plan/extra optional).
 */
export function tokensToEnv(
  keys: OAuthEnvKeys,
  tokens: OAuthTokens,
): Record<string, string> {
  const out: Record<string, string> = {
    [keys.access]: tokens.access,
    [keys.refresh]: tokens.refresh,
    [keys.expiresAt]: String(tokens.expiresAtMs),
  };
  if (tokens.identity.email) out[keys.email] = tokens.identity.email;
  if (tokens.identity.plan) out[keys.plan] = tokens.identity.plan;
  for (const [name, envKey] of Object.entries(keys.extra)) {
    const value = tokens.extra[name];
    if (value) out[envKey] = value;
  }
  return out;
}

/**
 * Reads tokens back from env. Returns undefined unless access + refresh + every
 * required `extra` key is present.
 */
export function readTokensFromEnv(
  keys: OAuthEnvKeys,
  env: NodeJS.ProcessEnv = process.env,
): OAuthTokens | undefined {
  const access = env[keys.access];
  const refresh = env[keys.refresh];
  if (!access || !refresh) return undefined;

  const extra: Record<string, string> = {};
  for (const [name, envKey] of Object.entries(keys.extra)) {
    const value = env[envKey];
    if (!value) return undefined; // a required extra (e.g. accountId) is missing
    extra[name] = value;
  }

  return {
    access,
    refresh,
    expiresAtMs: Number(env[keys.expiresAt]),
    extra,
    // env reads are already string | undefined, which matches the optional fields.
    identity: { email: env[keys.email], plan: env[keys.plan] },
  };
}

/**
 * Whether a token expiring at `expiresAtMs` should be refreshed now.
 */
export function isExpired(
  expiresAtMs: number,
  now = Date.now(),
  thresholdMs = OAUTH_REFRESH_THRESHOLD_MS,
): boolean {
  return !Number.isFinite(expiresAtMs) || now >= expiresAtMs - thresholdMs;
}

/**
 * `email (Plan)` display label from an identity.
 */
export function formatAccount(
  email: string | undefined,
  plan: string | undefined,
): string | undefined {
  const pretty = plan
    ? plan.charAt(0).toUpperCase() + plan.slice(1)
    : undefined;
  if (email && pretty) return `${email} (${pretty})`;
  return email ?? pretty;
}
