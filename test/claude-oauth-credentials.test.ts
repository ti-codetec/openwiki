import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  getCredentialSetupDetail,
  getInitialStep,
  getNextStepAfterProvider,
  needsCredentialSetup,
} from "../src/credentials.tsx";
import type { OAuthTokens } from "../src/agent/oauth/index.ts";

const MANAGED_KEYS = [
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  "LANGSMITH_API_KEY",
  "CLAUDE_OAUTH_ACCESS_TOKEN",
  "CLAUDE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_OAUTH_EXPIRES_AT",
  "CLAUDE_OAUTH_EMAIL",
  "CLAUDE_OAUTH_PLAN",
] as const;

const FAR_FUTURE = String(Date.now() + 60 * 60 * 1000);
const PAST = String(Date.now() - 60 * 60 * 1000);

let snapshot: Record<string, string | undefined>;

function set(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/** Stores a complete Claude subscription token set, as a real login would. */
function storeClaudeTokens(expiresAt: string = FAR_FUTURE): void {
  set("CLAUDE_OAUTH_ACCESS_TOKEN", "sk-ant-oat01-access");
  set("CLAUDE_OAUTH_REFRESH_TOKEN", "sk-ant-ort01-refresh");
  set("CLAUDE_OAUTH_EXPIRES_AT", expiresAt);
}

beforeEach(() => {
  snapshot = {};
  for (const key of MANAGED_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    set(key, snapshot[key]);
  }
});

describe("claude-oauth credential step transitions", () => {
  test("routes to oauth-login when no token is stored", () => {
    set("OPENWIKI_PROVIDER", "claude-oauth");

    expect(getInitialStep(null, "claude-oauth")).toBe("oauth-login");
    expect(getNextStepAfterProvider("claude-oauth", null)).toBe("oauth-login");
    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("routes to oauth-login when the stored token is expired", () => {
    set("OPENWIKI_PROVIDER", "claude-oauth");
    storeClaudeTokens(PAST);

    expect(getInitialStep(null, "claude-oauth")).toBe("oauth-login");
    expect(needsCredentialSetup(null)).toBe(true);
  });

  test("skips oauth-login when a valid token is stored", () => {
    set("OPENWIKI_PROVIDER", "claude-oauth");
    storeClaudeTokens();

    // No model configured yet, so setup continues at the model step.
    expect(getInitialStep(null, "claude-oauth")).toBe("model");
    expect(getNextStepAfterProvider("claude-oauth", null)).toBe("model");
  });
});

describe("getCredentialSetupDetail uses the provider label, not a hardcoded vendor", () => {
  test("prompts to sign in with the Claude account label", () => {
    expect(getCredentialSetupDetail("claude-oauth")).toBe(
      "sign in with your Anthropic (Claude login) account",
    );
  });

  test("still prompts with the ChatGPT label for openai-chatgpt", () => {
    expect(getCredentialSetupDetail("openai-chatgpt")).toBe(
      "sign in with your OpenAI (ChatGPT login) account",
    );
  });

  test("shows the freshly-logged-in account before it is persisted", () => {
    const tokens: OAuthTokens = {
      access: "sk-ant-oat01-access",
      refresh: "sk-ant-ort01-refresh",
      expiresAtMs: Date.now() + 60_000,
      extra: {},
      identity: { email: "dev@example.com", plan: "team" },
    };

    expect(getCredentialSetupDetail("claude-oauth", tokens)).toBe(
      "signed in as dev@example.com (Team)",
    );
  });
});
