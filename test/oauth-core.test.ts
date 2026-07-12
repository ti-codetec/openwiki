import { describe, expect, test } from "vitest";
import { parseManualCallbackInput } from "../src/agent/oauth/flow.ts";
import {
  OAUTH_REFRESH_THRESHOLD_MS,
  formatAccount,
  isExpired,
  readTokensFromEnv,
  tokensToEnv,
} from "../src/agent/oauth/token-store.ts";
import { decodeJwtPayload } from "../src/agent/oauth/jwt.ts";
import { openaiChatgptAdapter } from "../src/agent/oauth/openai-chatgpt.ts";
import type { OAuthEnvKeys, OAuthTokens } from "../src/agent/oauth/types.ts";

/** Encodes an object as the payload segment of an unsigned JWT-shaped string. */
function makeJwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");

  return `${header}.${body}.signature`;
}

describe("parseManualCallbackInput", () => {
  test("extracts code and state from a full redirect URL", () => {
    expect(
      parseManualCallbackInput(
        "http://localhost:1455/auth/callback?code=ac_123&scope=openid&state=abc",
      ),
    ).toEqual({ code: "ac_123", state: "abc" });
  });

  test("extracts code and state from a bare query string", () => {
    expect(parseManualCallbackInput("code=ac_123&state=abc")).toEqual({
      code: "ac_123",
      state: "abc",
    });
    expect(parseManualCallbackInput("?code=ac_123&state=abc")).toEqual({
      code: "ac_123",
      state: "abc",
    });
  });

  test("treats a bare value as the code with no state", () => {
    expect(parseManualCallbackInput("  ac_123  ")).toEqual({
      code: "ac_123",
      state: undefined,
    });
  });

  test("splits a bare `code#state` paste (Claude manual copy flow)", () => {
    // Claude's copy-the-code page hands back `<code>#<state>`; the `#state`
    // suffix must not be sent as part of the authorization code.
    expect(parseManualCallbackInput("ac_123#st_456")).toEqual({
      code: "ac_123",
      state: "st_456",
    });
    expect(parseManualCallbackInput("  ac_123#st_456  ")).toEqual({
      code: "ac_123",
      state: "st_456",
    });
  });

  test("returns undefined code for empty input", () => {
    expect(parseManualCallbackInput("   ")).toEqual({
      code: undefined,
      state: undefined,
    });
  });

  test("returns undefined code when a URL has no code param", () => {
    expect(
      parseManualCallbackInput("http://localhost:1455/auth/callback?state=abc"),
    ).toEqual({ code: undefined, state: "abc" });
  });
});

describe("isExpired", () => {
  const now = 1_000_000;

  test("is not expired well before expiry", () => {
    expect(isExpired(now + 10 * 60 * 1000, now)).toBe(false);
  });

  test("is expired once past expiry", () => {
    expect(isExpired(now - 1, now)).toBe(true);
  });

  test("is expired within the near-expiry threshold", () => {
    expect(isExpired(now + OAUTH_REFRESH_THRESHOLD_MS - 1, now)).toBe(true);
  });

  test("treats a non-numeric expiry as expired", () => {
    expect(isExpired(Number.NaN, now)).toBe(true);
  });
});

describe("formatAccount", () => {
  test("combines email and capitalized plan", () => {
    expect(formatAccount("a@b.com", "plus")).toBe("a@b.com (Plus)");
  });

  test("falls back to whichever value is present", () => {
    expect(formatAccount("a@b.com", undefined)).toBe("a@b.com");
    expect(formatAccount(undefined, "pro")).toBe("Pro");
    expect(formatAccount(undefined, undefined)).toBeUndefined();
  });
});

describe("decodeJwtPayload", () => {
  test("decodes the payload of a JWT-shaped token", () => {
    expect(decodeJwtPayload(makeJwt({ sub: "user_1", n: 2 }))).toEqual({
      sub: "user_1",
      n: 2,
    });
  });

  test("returns undefined for a value that is not a JWT", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeUndefined();
  });

  test("returns undefined when the payload is not valid JSON", () => {
    // A well-shaped three-segment token whose middle segment is not JSON.
    expect(decodeJwtPayload("header.not-json.signature")).toBeUndefined();
  });
});

describe("token env round-trip (generic, with a required extra)", () => {
  const KEYS: OAuthEnvKeys = {
    access: "T_ACCESS",
    refresh: "T_REFRESH",
    expiresAt: "T_EXPIRES_AT",
    email: "T_EMAIL",
    plan: "T_PLAN",
    extra: { accountId: "T_ACCOUNT_ID" },
  };

  const tokens: OAuthTokens = {
    access: "access-1",
    refresh: "refresh-1",
    expiresAtMs: 1_700_000_000_000,
    extra: { accountId: "acct_1" },
    identity: { email: "dev@example.com", plan: "plus" },
  };

  test("serializes every field onto its env key", () => {
    expect(tokensToEnv(KEYS, tokens)).toEqual({
      T_ACCESS: "access-1",
      T_REFRESH: "refresh-1",
      T_EXPIRES_AT: "1700000000000",
      T_EMAIL: "dev@example.com",
      T_PLAN: "plus",
      T_ACCOUNT_ID: "acct_1",
    });
  });

  test("round-trips back to the same tokens", () => {
    expect(readTokensFromEnv(KEYS, tokensToEnv(KEYS, tokens))).toEqual(tokens);
  });

  test("omits email and plan when the identity is unknown", () => {
    const env = tokensToEnv(KEYS, {
      ...tokens,
      identity: { email: undefined, plan: undefined },
    });

    expect(env).not.toHaveProperty("T_EMAIL");
    expect(env).not.toHaveProperty("T_PLAN");
    expect(readTokensFromEnv(KEYS, env)).toEqual({
      ...tokens,
      identity: { email: undefined, plan: undefined },
    });
  });

  test("reads back undefined when the required extra is missing", () => {
    const env = tokensToEnv(KEYS, tokens);
    delete env.T_ACCOUNT_ID;

    expect(readTokensFromEnv(KEYS, env)).toBeUndefined();
  });

  test("reads back undefined from an empty environment", () => {
    expect(readTokensFromEnv(KEYS, {})).toBeUndefined();
  });
});

describe("openaiChatgptAdapter env contract", () => {
  const oauthTokens: OAuthTokens = {
    access: "access-1",
    refresh: "refresh-1",
    expiresAtMs: 1_700_000_000_000,
    extra: { accountId: "acct_1" },
    identity: { email: "dev@example.com", plan: "plus" },
  };

  // The exact env keys the adapter must persist under (the contract the Codex
  // backend and the wizard both depend on).
  const fullEnv = {
    OPENAI_CHATGPT_ACCESS_TOKEN: "access-1",
    OPENAI_CHATGPT_REFRESH_TOKEN: "refresh-1",
    OPENAI_CHATGPT_EXPIRES_AT: "1700000000000",
    OPENAI_CHATGPT_ACCOUNT_ID: "acct_1",
    OPENAI_CHATGPT_EMAIL: "dev@example.com",
    OPENAI_CHATGPT_PLAN: "plus",
  };

  test("tokensToEnv writes the OPENAI_CHATGPT_* keys", () => {
    expect(openaiChatgptAdapter.tokensToEnv(oauthTokens)).toEqual(fullEnv);
  });

  test("tokensToEnv omits email/plan when the identity is absent", () => {
    const env = openaiChatgptAdapter.tokensToEnv({
      ...oauthTokens,
      identity: { email: undefined, plan: undefined },
    });

    expect(env).not.toHaveProperty("OPENAI_CHATGPT_EMAIL");
    expect(env).not.toHaveProperty("OPENAI_CHATGPT_PLAN");
  });

  test("readTokensFromEnv reads back what tokensToEnv wrote", () => {
    expect(openaiChatgptAdapter.readTokensFromEnv(fullEnv)).toEqual(
      oauthTokens,
    );
  });

  test("readTokensFromEnv rejects an env set missing a required field", () => {
    for (const key of [
      "OPENAI_CHATGPT_ACCESS_TOKEN",
      "OPENAI_CHATGPT_REFRESH_TOKEN",
      "OPENAI_CHATGPT_ACCOUNT_ID",
    ]) {
      const env: NodeJS.ProcessEnv = { ...fullEnv };
      delete env[key];

      expect(openaiChatgptAdapter.readTokensFromEnv(env)).toBeUndefined();
    }
  });
});
