import { describe, expect, test, vi } from "vitest";
import {
  CLAUDE_OAUTH_BETA,
  anthropicClaudeAdapter,
  createClaudeOAuthFetch,
} from "../src/agent/oauth/anthropic-claude.ts";
import { getOAuthAdapter } from "../src/agent/oauth/registry.ts";
import { openaiChatgptAdapter } from "../src/agent/oauth/openai-chatgpt.ts";
import type { OAuthTokens } from "../src/agent/oauth/types.ts";

describe("anthropicClaudeAdapter env contract", () => {
  const tokens: OAuthTokens = {
    access: "sk-ant-oat01-access",
    refresh: "sk-ant-ort01-refresh",
    expiresAtMs: 1_700_000_000_000,
    extra: {},
    identity: { email: "dev@example.com", plan: "Acme Inc" },
  };

  test("round-trips tokens through the CLAUDE_OAUTH_* env keys", () => {
    const env = anthropicClaudeAdapter.tokensToEnv(tokens);

    expect(env).toEqual({
      CLAUDE_OAUTH_ACCESS_TOKEN: "sk-ant-oat01-access",
      CLAUDE_OAUTH_REFRESH_TOKEN: "sk-ant-ort01-refresh",
      CLAUDE_OAUTH_EXPIRES_AT: "1700000000000",
      CLAUDE_OAUTH_EMAIL: "dev@example.com",
      CLAUDE_OAUTH_PLAN: "Acme Inc",
    });
    expect(anthropicClaudeAdapter.readTokensFromEnv(env)).toEqual(tokens);
  });

  test("needs no account-id-style extra to read back", () => {
    // Claude has no required extra, so access + refresh are sufficient.
    expect(
      anthropicClaudeAdapter.readTokensFromEnv({
        CLAUDE_OAUTH_ACCESS_TOKEN: "a",
        CLAUDE_OAUTH_REFRESH_TOKEN: "r",
        CLAUDE_OAUTH_EXPIRES_AT: "1700000000000",
      }),
    ).toEqual({
      access: "a",
      refresh: "r",
      expiresAtMs: 1_700_000_000_000,
      extra: {},
      identity: { email: undefined, plan: undefined },
    });
  });

  test("reads back undefined when access or refresh is missing", () => {
    expect(
      anthropicClaudeAdapter.readTokensFromEnv({
        CLAUDE_OAUTH_ACCESS_TOKEN: "a",
      }),
    ).toBeUndefined();
    expect(anthropicClaudeAdapter.readTokensFromEnv({})).toBeUndefined();
  });

  test("formatAccountFromEnv builds an `email (Plan)` label", () => {
    expect(
      anthropicClaudeAdapter.formatAccountFromEnv({
        CLAUDE_OAUTH_EMAIL: "dev@example.com",
        CLAUDE_OAUTH_PLAN: "team",
      }),
    ).toBe("dev@example.com (Team)");
    expect(anthropicClaudeAdapter.formatAccountFromEnv({})).toBeUndefined();
  });
});

describe("createClaudeOAuthFetch", () => {
  test("sets Bearer auth, removes x-api-key, and adds the beta header when absent", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    const claudeFetch = createClaudeOAuthFetch(
      "sk-ant-oat01-access",
      fetchMock,
    );

    await claudeFetch("https://api.anthropic.com/v1/messages", {
      headers: { "x-api-key": "leaked-key" },
      method: "POST",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Headers }];
    expect(init.headers.get("authorization")).toBe(
      "Bearer sk-ant-oat01-access",
    );
    expect(init.headers.has("x-api-key")).toBe(false);
    expect(init.headers.get("anthropic-beta")).toBe(CLAUDE_OAUTH_BETA);
  });

  test("preserves a caller-provided anthropic-beta header", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    const claudeFetch = createClaudeOAuthFetch(
      "sk-ant-oat01-access",
      fetchMock,
    );

    await claudeFetch("https://api.anthropic.com/v1/messages", {
      headers: { "anthropic-beta": "custom-beta" },
      method: "POST",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Headers }];
    expect(init.headers.get("anthropic-beta")).toBe("custom-beta");
    expect(init.headers.get("authorization")).toBe(
      "Bearer sk-ant-oat01-access",
    );
  });
});

describe("getOAuthAdapter", () => {
  test("returns the Claude adapter for claude-oauth", () => {
    expect(getOAuthAdapter("claude-oauth")).toBe(anthropicClaudeAdapter);
  });

  test("returns the ChatGPT adapter for openai-chatgpt", () => {
    expect(getOAuthAdapter("openai-chatgpt")).toBe(openaiChatgptAdapter);
  });

  test("returns undefined for api-key providers", () => {
    expect(getOAuthAdapter("anthropic")).toBeUndefined();
    expect(getOAuthAdapter("openai")).toBeUndefined();
    expect(getOAuthAdapter("openrouter")).toBeUndefined();
  });
});
