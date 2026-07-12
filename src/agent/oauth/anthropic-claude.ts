import {
  CLAUDE_OAUTH_ACCESS_TOKEN_ENV_KEY,
  CLAUDE_OAUTH_EMAIL_ENV_KEY,
  CLAUDE_OAUTH_EXPIRES_AT_ENV_KEY,
  CLAUDE_OAUTH_PLAN_ENV_KEY,
  CLAUDE_OAUTH_REFRESH_TOKEN_ENV_KEY,
} from "../../constants.js";
import { runOAuthLogin, runOAuthRefresh } from "./flow.js";
import {
  formatAccount,
  isExpired,
  readTokensFromEnv,
  tokensToEnv,
} from "./token-store.js";
import { objectClaim, stringClaim } from "./jwt.js";
import type {
  OAuthAdapter,
  OAuthEnvKeys,
  OAuthFlowSpec,
  OAuthTokenResponse,
  OAuthTokens,
} from "./types.js";

/**
 * Anthropic API base and the beta flags a subscription (OAuth) request needs,
 * confirmed empirically. `createModel` uses these.
 */
export const CLAUDE_API_BASE_URL = "https://api.anthropic.com";
export const CLAUDE_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20";

/**
 * OAuth flow parameters, extracted from Claude Code v2.1.206 (Phase 1). This is
 * the subscription flow (claude.ai authorize + user:inference), not the console
 * API-key flow.
 */
const FLOW: OAuthFlowSpec = {
  clientId:
    process.env.CLAUDE_CODE_OAUTH_CLIENT_ID ??
    "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  scope:
    "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  callbackPort: 54545, // any free localhost port; the client accepts dynamic loopback ports
  callbackPath: "/callback",
  tokenBodyFormat: "json", // confirmed: the token endpoint returns 200 for a JSON body
  sendStateInTokenExchange: true, // Anthropic requires `state` in the exchange body
};

const ENV_KEYS: OAuthEnvKeys = {
  access: CLAUDE_OAUTH_ACCESS_TOKEN_ENV_KEY,
  refresh: CLAUDE_OAUTH_REFRESH_TOKEN_ENV_KEY,
  expiresAt: CLAUDE_OAUTH_EXPIRES_AT_ENV_KEY,
  email: CLAUDE_OAUTH_EMAIL_ENV_KEY,
  plan: CLAUDE_OAUTH_PLAN_ENV_KEY,
  extra: {}, // Claude needs no account-id-style extra
};

/**
 * Maps the token response to tokens. Confirmed in Phase 1: Claude's access and
 * refresh tokens are opaque (`sk-ant-oat01...` / `sk-ant-ort01...`), not JWTs, so
 * identity comes from the `account` and `organization` objects in the response
 * body, not from decoding the token.
 */
function toTokens(raw: OAuthTokenResponse): OAuthTokens {
  const account = objectClaim(raw.account) ?? {};
  const organization = objectClaim(raw.organization) ?? {};
  return {
    access: raw.access_token,
    refresh: raw.refresh_token,
    expiresAtMs: Date.now() + raw.expires_in * 1000,
    extra: {},
    identity: {
      email: stringClaim(account.email_address),
      // Claude returns an organization name rather than a plan tier; use it as
      // the display label.
      plan: stringClaim(organization.name),
    },
  };
}

/**
 * A thin request adapter that guarantees Bearer auth + the OAuth beta header.
 */
export function createClaudeOAuthFetch(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.delete("x-api-key");
    if (!headers.has("anthropic-beta"))
      headers.set("anthropic-beta", CLAUDE_OAUTH_BETA);
    return fetchImpl(input, { ...init, headers });
  };
}

/**
 * The Claude subscription OAuth adapter.
 */
export const anthropicClaudeAdapter: OAuthAdapter = {
  async login(openUrl, onReady) {
    return toTokens(await runOAuthLogin(FLOW, openUrl, onReady));
  },
  async refresh(refreshToken) {
    return toTokens(await runOAuthRefresh(FLOW, refreshToken));
  },
  readTokensFromEnv: (env) => readTokensFromEnv(ENV_KEYS, env),
  tokensToEnv: (tokens) => tokensToEnv(ENV_KEYS, tokens),
  isExpired: (expiresAtMs, now) => isExpired(expiresAtMs, now),
  formatAccountFromEnv: (env = process.env) =>
    formatAccount(env[ENV_KEYS.email], env[ENV_KEYS.plan]),
};
