import { afterEach, describe, expect, test, vi } from "vitest";

// `ensureFreshOAuthTokens` persists rotated tokens through `saveOpenWikiEnv`,
// which writes to `~/.openwiki/.env`; stub it so the test has no FS side effect.
const { saveOpenWikiEnvMock } = vi.hoisted(() => ({
  saveOpenWikiEnvMock: vi.fn(() => Promise.resolve()),
}));
vi.mock("../src/env.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/env.ts")>();
  return { ...actual, saveOpenWikiEnv: saveOpenWikiEnvMock };
});

import {
  OAUTH_LOGIN_INCOMPLETE_MESSAGE,
  ensureFreshOAuthTokens,
} from "../src/agent/index.ts";
import type { OAuthAdapter, OAuthTokens } from "../src/agent/oauth/index.ts";

const STORED: OAuthTokens = {
  access: "access-old",
  refresh: "refresh-old",
  expiresAtMs: 1_000,
  extra: {},
  identity: { email: undefined, plan: undefined },
};

/** A fully-stubbed adapter; individual tests override the methods they drive. */
function makeAdapter(overrides: Partial<OAuthAdapter>): OAuthAdapter {
  return {
    login: vi.fn(),
    refresh: vi.fn(),
    readTokensFromEnv: vi.fn(),
    tokensToEnv: vi.fn(),
    isExpired: vi.fn(),
    formatAccountFromEnv: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  saveOpenWikiEnvMock.mockClear();
});

describe("ensureFreshOAuthTokens", () => {
  test("throws the incomplete-login message when no tokens are stored", async () => {
    const adapter = makeAdapter({ readTokensFromEnv: () => undefined });

    await expect(ensureFreshOAuthTokens(adapter)).rejects.toThrow(
      OAUTH_LOGIN_INCOMPLETE_MESSAGE,
    );
    expect(saveOpenWikiEnvMock).not.toHaveBeenCalled();
  });

  test("does not refresh or persist when the token is still fresh", async () => {
    const refresh = vi.fn();
    const adapter = makeAdapter({
      readTokensFromEnv: () => STORED,
      isExpired: () => false,
      refresh,
    });

    await ensureFreshOAuthTokens(adapter);

    expect(refresh).not.toHaveBeenCalled();
    expect(saveOpenWikiEnvMock).not.toHaveBeenCalled();
  });

  test("refreshes with the stored refresh token and persists the rotation", async () => {
    const rotated: OAuthTokens = {
      access: "access-new",
      refresh: "refresh-new",
      expiresAtMs: 2_000,
      extra: {},
      identity: { email: undefined, plan: undefined },
    };
    const refresh = vi.fn(() => Promise.resolve(rotated));
    const tokensToEnv = vi.fn(() => ({ TOKEN_ENV: "serialized" }));
    const adapter = makeAdapter({
      readTokensFromEnv: () => STORED,
      isExpired: () => true,
      refresh,
      tokensToEnv,
    });

    await ensureFreshOAuthTokens(adapter);

    expect(refresh).toHaveBeenCalledWith("refresh-old");
    expect(tokensToEnv).toHaveBeenCalledWith(rotated);
    expect(saveOpenWikiEnvMock).toHaveBeenCalledWith({
      TOKEN_ENV: "serialized",
    });
  });
});
