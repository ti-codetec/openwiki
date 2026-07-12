import { afterEach, describe, expect, test, vi } from "vitest";
import { runOAuthLogin, runOAuthRefresh } from "../src/agent/oauth/flow.ts";
import type { OAuthFlowSpec } from "../src/agent/oauth/types.ts";

/** A minimal, valid token-endpoint response body. */
const TOKEN_OK = {
  access_token: "sk-access",
  refresh_token: "sk-refresh",
  expires_in: 3600,
};

/** Base spec; individual tests override `tokenBodyFormat` / state gating. */
const SPEC: OAuthFlowSpec = {
  clientId: "test-client",
  authorizeUrl: "https://example.com/oauth/authorize",
  tokenUrl: "https://example.com/oauth/token",
  scope: "user:profile user:inference",
  callbackPort: 0, // bind any free loopback port; manual submit bypasses HTTP
  callbackPath: "/callback",
  tokenBodyFormat: "json",
};

/**
 * Stubs global fetch with a canned response and captures the request init so
 * tests can assert the exact token-exchange body. Returns a getter for the
 * decoded body (JSON or form) of the last call.
 */
function stubTokenEndpoint(response: {
  ok: boolean;
  status: number;
  body: unknown;
}): () => Record<string, string> {
  let capturedBody = "";
  let capturedFormat: OAuthFlowSpec["tokenBodyFormat"] = "json";
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    // The flow always sends a string body (JSON or urlencoded form).
    capturedBody = init.body as string;
    const headers = init.headers as Record<string, string>;
    capturedFormat =
      headers["Content-Type"] === "application/json" ? "json" : "form";
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return () =>
    capturedFormat === "json"
      ? (JSON.parse(capturedBody) as Record<string, string>)
      : Object.fromEntries(new URLSearchParams(capturedBody));
}

/** Completes a login without a browser by submitting a bare code (no state). */
function loginViaManualPaste(spec: OAuthFlowSpec): Promise<unknown> {
  return runOAuthLogin(spec, vi.fn(), (handle) => {
    handle.submitManual("ac_test_code");
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runOAuthLogin token exchange", () => {
  test("echoes `state` in the body when the spec opts in", async () => {
    const body = stubTokenEndpoint({ ok: true, status: 200, body: TOKEN_OK });

    await loginViaManualPaste({ ...SPEC, sendStateInTokenExchange: true });

    const sent = body();
    expect(sent.grant_type).toBe("authorization_code");
    expect(sent.code).toBe("ac_test_code");
    expect(sent.client_id).toBe("test-client");
    expect(sent.code_verifier).toBeTruthy();
    expect(sent.redirect_uri).toContain("/callback");
    // The generated state is random; assert it is present and non-empty.
    expect(sent.state).toMatch(/^[0-9a-f]{32}$/u);
  });

  test("omits `state` from the body by default", async () => {
    const body = stubTokenEndpoint({ ok: true, status: 200, body: TOKEN_OK });

    await loginViaManualPaste({ ...SPEC, tokenBodyFormat: "form" });

    expect(body().state).toBeUndefined();
  });
});

describe("runOAuthRefresh token exchange", () => {
  test("posts a refresh_token grant and never includes state", async () => {
    const body = stubTokenEndpoint({ ok: true, status: 200, body: TOKEN_OK });

    const tokens = await runOAuthRefresh(
      { ...SPEC, sendStateInTokenExchange: true },
      "sk-refresh-old",
    );

    const sent = body();
    expect(sent).toEqual({
      grant_type: "refresh_token",
      refresh_token: "sk-refresh-old",
      client_id: "test-client",
    });
    expect(tokens.access_token).toBe("sk-access");
  });
});

describe("token-endpoint error handling", () => {
  test("surfaces the endpoint's error and error_description", async () => {
    stubTokenEndpoint({
      ok: false,
      status: 400,
      body: { error: "invalid_grant", error_description: "code has expired" },
    });

    await expect(runOAuthRefresh(SPEC, "sk-refresh-old")).rejects.toThrow(
      /400.*invalid_grant.*code has expired/u,
    );
  });

  test("still reports the status when the error body is not JSON", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: () => Promise.reject(new Error("not json")),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(runOAuthRefresh(SPEC, "sk-refresh-old")).rejects.toThrow(
      /Token request failed \(429\)/u,
    );
  });

  test("rejects a 200 response that is missing required fields", async () => {
    stubTokenEndpoint({
      ok: true,
      status: 200,
      body: { access_token: "only-access" },
    });

    await expect(runOAuthRefresh(SPEC, "sk-refresh-old")).rejects.toThrow(
      /missing fields: refresh_token, expires_in/u,
    );
  });
});
