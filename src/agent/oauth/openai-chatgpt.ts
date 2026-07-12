import {
  OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
  OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY,
  OPENAI_CHATGPT_EMAIL_ENV_KEY,
  OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY,
  OPENAI_CHATGPT_PLAN_ENV_KEY,
  OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY,
} from "../../constants.js";
import { runOAuthLogin, runOAuthRefresh } from "./flow.js";
import {
  readTokensFromEnv,
  tokensToEnv,
  isExpired,
  formatAccount,
} from "./token-store.js";
import { decodeJwtPayload, objectClaim, stringClaim } from "./jwt.js";
import type {
  OAuthAdapter,
  OAuthEnvKeys,
  OAuthFlowSpec,
  OAuthTokenResponse,
  OAuthTokens,
} from "./types.js";

/** Base URL for the Codex Responses backend; the OpenAI SDK appends `/responses`. */
export const CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Free-text client label sent as the `originator` header/param. */
export const CODEX_ORIGINATOR = "openwiki";

const CODEX_LUNA_MODEL_ID = "gpt-5.6-luna";
const CODEX_LUNA_ORIGINATOR = "codex_cli_rs";
const CODEX_LUNA_USER_AGENT = "codex_cli_rs/0.0.0";
export const CODEX_RESPONSES_LITE_HEADER =
  "x-openai-internal-codex-responses-lite";

/**
 * Adapts requests for the ChatGPT-backed Codex endpoint at the final fetch
 * boundary. LangChain supplies its own user agent after merging configured
 * headers, while Luna is exposed only to the Codex request identity and uses
 * the Responses Lite request constraints.
 */
export function createCodexFetch(
  modelId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  return async (input, init) => {
    const useLunaProtocol =
      modelId === CODEX_LUNA_MODEL_ID && isCodexResponsesRequest(input);

    if (init?.body != null && typeof init.body === "string") {
      try {
        const payload: unknown = JSON.parse(init.body);

        if (!isRecord(payload)) {
          return fetchImpl(input, init);
        }

        let changed = false;

        if (Array.isArray(payload.input)) {
          for (const item of payload.input) {
            if (isRecord(item) && item.role === "system") {
              item.role = "developer";
              changed = true;
            }
          }
        }

        if (useLunaProtocol) {
          const inputItems: unknown[] = Array.isArray(payload.input)
            ? payload.input
            : [];
          const prefix = [];

          if (Array.isArray(payload.tools)) {
            prefix.push({
              type: "additional_tools",
              role: "developer",
              tools: payload.tools,
            });
          }

          if (
            typeof payload.instructions === "string" &&
            payload.instructions.length > 0
          ) {
            prefix.push({
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: payload.instructions }],
            });
          }

          payload.input = [...prefix, ...inputItems];
          delete payload.instructions;
          delete payload.tools;
          payload.reasoning = {
            ...(isRecord(payload.reasoning) ? payload.reasoning : {}),
            context: "all_turns",
          };
          payload.parallel_tool_calls = false;
          changed = true;
        }

        if (changed) {
          init = { ...init, body: JSON.stringify(payload) };
        }
      } catch {
        // Non-JSON body: forward unchanged.
      }
    }

    if (useLunaProtocol) {
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      );
      new Headers(init?.headers).forEach((value, key) =>
        headers.set(key, value),
      );
      headers.set("originator", CODEX_LUNA_ORIGINATOR);
      headers.set("user-agent", CODEX_LUNA_USER_AGENT);
      headers.set(CODEX_RESPONSES_LITE_HEADER, "true");
      init = { ...init, headers };
    }

    return fetchImpl(input, init);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexResponsesRequest(input: Parameters<typeof fetch>[0]): boolean {
  const requestUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  try {
    const actual = new URL(requestUrl);
    const expected = new URL(`${CODEX_RESPONSES_BASE_URL}/responses`);

    return (
      actual.origin === expected.origin && actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

const FLOW: OAuthFlowSpec = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  scope: "openid profile email offline_access",
  callbackPort: 1455,
  callbackPath: "/auth/callback",
  tokenBodyFormat: "form",
  extraAuthorizeParams: {
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: CODEX_ORIGINATOR,
  },
};

const ENV_KEYS: OAuthEnvKeys = {
  access: OPENAI_CHATGPT_ACCESS_TOKEN_ENV_KEY,
  refresh: OPENAI_CHATGPT_REFRESH_TOKEN_ENV_KEY,
  expiresAt: OPENAI_CHATGPT_EXPIRES_AT_ENV_KEY,
  email: OPENAI_CHATGPT_EMAIL_ENV_KEY,
  plan: OPENAI_CHATGPT_PLAN_ENV_KEY,
  extra: { accountId: OPENAI_CHATGPT_ACCOUNT_ID_ENV_KEY },
};

/**
 * Maps a raw token response to tokens, decoding the Codex account id (required).
 */
function toTokens(raw: OAuthTokenResponse): OAuthTokens {
  const payload = decodeJwtPayload(raw.access_token);
  const auth = objectClaim(payload?.["https://api.openai.com/auth"]);
  const profile = objectClaim(payload?.["https://api.openai.com/profile"]);
  const accountId = stringClaim(auth?.chatgpt_account_id);
  if (!accountId)
    throw new Error("Failed to extract account id from ChatGPT token.");
  return {
    access: raw.access_token,
    refresh: raw.refresh_token,
    expiresAtMs: Date.now() + raw.expires_in * 1000,
    extra: { accountId },
    identity: {
      email: stringClaim(profile?.email),
      plan: stringClaim(auth?.chatgpt_plan_type),
    },
  };
}

/**
 * The OpenAI ChatGPT OAuth adapter.
 */
export const openaiChatgptAdapter: OAuthAdapter = {
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
