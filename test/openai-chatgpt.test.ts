import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CODEX_RESPONSES_LITE_HEADER,
  createCodexFetch,
  openaiChatgptAdapter,
} from "../src/agent/oauth/openai-chatgpt.ts";

function makeAccessToken(
  accountId: string | null,
  extra: { email?: string; planType?: string } = {},
): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const auth: Record<string, unknown> = {};

  if (accountId !== null) {
    auth.chatgpt_account_id = accountId;
  }

  if (extra.planType !== undefined) {
    auth.chatgpt_plan_type = extra.planType;
  }

  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": auth,
      ...(extra.email !== undefined
        ? { "https://api.openai.com/profile": { email: extra.email } }
        : {}),
    }),
  ).toString("base64url");

  return `${header}.${payload}.signature`;
}

function stubTokenResponse(
  body: unknown,
  status = 200,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
    ),
  );

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Codex Responses requests", () => {
  test("uses the Luna request identity and Responses Lite constraints", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    const codexFetch = createCodexFetch("gpt-5.6-luna", fetchMock);

    await codexFetch("https://chatgpt.com/backend-api/codex/responses", {
      body: JSON.stringify({
        input: [{ role: "system", content: "Follow the repository rules." }],
        instructions: "You are a coding agent.",
        parallel_tool_calls: true,
        reasoning: { effort: "high" },
        tools: [
          {
            type: "function",
            name: "read_file",
            parameters: { type: "object" },
          },
        ],
      }),
      headers: {
        authorization: "Bearer test-token",
        "user-agent": "langchainjs-openai/1.0.0",
      },
      method: "POST",
    });

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: string; headers: Headers },
    ];
    expect(init.headers.get("originator")).toBe("codex_cli_rs");
    expect(init.headers.get("user-agent")).toBe("codex_cli_rs/0.0.0");
    expect(init.headers.get(CODEX_RESPONSES_LITE_HEADER)).toBe("true");
    expect(init.headers.get("authorization")).toBe("Bearer test-token");
    expect(JSON.parse(init.body)).toEqual({
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "function",
              name: "read_file",
              parameters: { type: "object" },
            },
          ],
        },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "You are a coding agent." }],
        },
        { role: "developer", content: "Follow the repository rules." },
      ],
      parallel_tool_calls: false,
      reasoning: { effort: "high", context: "all_turns" },
    });
  });

  test.each(["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5"])(
    "preserves the existing request behavior for %s",
    async (modelId) => {
      const fetchMock = vi.fn(() => Promise.resolve(new Response()));
      const codexFetch = createCodexFetch(modelId, fetchMock);

      await codexFetch("https://chatgpt.com/backend-api/codex/responses", {
        body: JSON.stringify({
          input: [{ role: "system", content: "System prompt" }],
          parallel_tool_calls: true,
        }),
        headers: {
          originator: "openwiki",
          "user-agent": "langchainjs-openai/1.0.0",
        },
        method: "POST",
      });

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { body: string; headers: Record<string, string> },
      ];
      expect(init.headers).toEqual({
        originator: "openwiki",
        "user-agent": "langchainjs-openai/1.0.0",
      });
      expect(JSON.parse(init.body)).toEqual({
        input: [{ role: "developer", content: "System prompt" }],
        parallel_tool_calls: true,
      });
    },
  );

  test("does not apply Luna identity outside the Codex Responses endpoint", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    const codexFetch = createCodexFetch("gpt-5.6-luna", fetchMock);

    await codexFetch("https://example.com/responses", {
      body: JSON.stringify({ input: [] }),
      headers: { originator: "openwiki" },
      method: "POST",
    });

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers).toEqual({ originator: "openwiki" });
  });

  test("preserves Request headers when adding the Luna headers", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    const codexFetch = createCodexFetch("gpt-5.6-luna", fetchMock);
    const request = new Request(
      "https://chatgpt.com/backend-api/codex/responses?stream=true",
      { headers: { "chatgpt-account-id": "acct_test" }, method: "POST" },
    );

    await codexFetch(request, {
      body: JSON.stringify({ input: [] }),
      headers: { authorization: "Bearer test-token" },
    });

    const [, init] = fetchMock.mock.calls[0] as [Request, { headers: Headers }];
    expect(init.headers.get("chatgpt-account-id")).toBe("acct_test");
    expect(init.headers.get("authorization")).toBe("Bearer test-token");
    expect(init.headers.get(CODEX_RESPONSES_LITE_HEADER)).toBe("true");
  });

  test("passes non-object JSON bodies through unchanged", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response()));
    const codexFetch = createCodexFetch("gpt-5.6-luna", fetchMock);

    await codexFetch("https://chatgpt.com/backend-api/codex/responses", {
      body: "null",
      headers: { originator: "openwiki" },
      method: "POST",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        body: "null",
        headers: { originator: "openwiki" },
        method: "POST",
      },
    );
  });
});

describe("openaiChatgptAdapter.refresh", () => {
  test("parses tokens and decodes identity from the access JWT", async () => {
    const access = makeAccessToken("acct_abc123", {
      email: "dev@example.com",
      planType: "plus",
    });
    const fetchMock = stubTokenResponse({
      access_token: access,
      refresh_token: "refresh-next",
      expires_in: 3600,
    });

    const before = Date.now();
    const tokens = await openaiChatgptAdapter.refresh("refresh-prev");

    expect(tokens.access).toBe(access);
    expect(tokens.refresh).toBe("refresh-next");
    expect(tokens.extra.accountId).toBe("acct_abc123");
    expect(tokens.identity.email).toBe("dev@example.com");
    expect(tokens.identity.plan).toBe("plus");
    expect(tokens.expiresAtMs).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expiresAtMs).toBeLessThanOrEqual(Date.now() + 3600 * 1000);

    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://auth.openai.com/oauth/token");
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=refresh-prev");
  });

  test("throws when a required response field is missing", async () => {
    stubTokenResponse({
      access_token: makeAccessToken("acct_abc123"),
      expires_in: 3600,
    });

    await expect(openaiChatgptAdapter.refresh("refresh-prev")).rejects.toThrow(
      /missing fields.*refresh_token/u,
    );
  });

  test("throws when the account id cannot be decoded", async () => {
    stubTokenResponse({
      access_token: makeAccessToken(null),
      refresh_token: "refresh-next",
      expires_in: 3600,
    });

    await expect(openaiChatgptAdapter.refresh("refresh-prev")).rejects.toThrow(
      /account id/u,
    );
  });

  test("throws on a non-2xx response", async () => {
    stubTokenResponse("nope", 401);

    await expect(openaiChatgptAdapter.refresh("refresh-prev")).rejects.toThrow(
      /Token request failed \(401\)/u,
    );
  });
});
