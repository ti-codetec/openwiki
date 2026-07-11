import http from "node:http";
import { randomBytes } from "node:crypto";
import { generatePkce } from "./pkce.js";
import type {
  OAuthFlowSpec,
  OAuthLoginHandle,
  OAuthTokenResponse,
} from "./types.js";

/**
 * Extracts `code`/`state` from a pasted redirect URL, bare query string, or
 * bare code.
 */
export function parseManualCallbackInput(input: string): {
  code: string | undefined;
  state: string | undefined;
} {
  const trimmed = input.trim();
  // URLSearchParams.get returns string | null, so coalesce to undefined.
  if (/^https?:\/\//iu.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        code: url.searchParams.get("code") ?? undefined,
        state: url.searchParams.get("state") ?? undefined,
      };
    } catch {
      return { code: undefined, state: undefined };
    }
  }
  if (trimmed.includes("code=")) {
    const params = new URLSearchParams(
      trimmed.startsWith("?") ? trimmed.slice(1) : trimmed,
    );
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: trimmed.length > 0 ? trimmed : undefined, state: undefined };
}

/**
 * POSTs to the token endpoint using the spec's body encoding, and validates the
 * response shape. Returns the full parsed body so opaque-token vendors can read
 * identity fields (e.g. Claude's `account`/`organization`).
 */
async function postToken(
  spec: OAuthFlowSpec,
  params: Record<string, string>,
): Promise<OAuthTokenResponse> {
  const res = await fetch(spec.tokenUrl, {
    method: "POST",
    headers:
      spec.tokenBodyFormat === "json"
        ? { "Content-Type": "application/json" }
        : { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      spec.tokenBodyFormat === "json"
        ? JSON.stringify(params)
        : new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `Token request failed (${res.status}). Try signing in again.`,
    );
  }
  const json = (await res.json()) as Partial<OAuthTokenResponse>;
  const missing = (
    ["access_token", "refresh_token", "expires_in"] as const
  ).filter((field) => json[field] === undefined || json[field] === null);
  if (missing.length > 0) {
    throw new Error(`Token response missing fields: ${missing.join(", ")}.`);
  }
  return json as OAuthTokenResponse;
}

/**
 * Runs the Authorization Code + PKCE browser login against `spec`, with a
 * loopback callback server and a manual-paste fallback. Returns the raw token
 * response.
 */
export async function runOAuthLogin(
  spec: OAuthFlowSpec,
  openUrl: (url: string) => void,
  onReady?: (handle: OAuthLoginHandle) => void,
): Promise<OAuthTokenResponse> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");
  const redirectUri = `http://localhost:${spec.callbackPort}${spec.callbackPath}`;

  const authUrl = new URL(spec.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", spec.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", spec.scope);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  for (const [key, value] of Object.entries(spec.extraAuthorizeParams ?? {})) {
    authUrl.searchParams.set(key, value);
  }

  const code = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (authCode: string): void => {
      if (settled) return;
      settled = true;
      server.close();
      resolve(authCode);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      server.close();
      reject(error);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(
        req.url ?? "",
        `http://localhost:${spec.callbackPort}`,
      );
      if (url.pathname !== spec.callbackPath) {
        res.writeHead(404).end();
        return;
      }
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400).end("State mismatch");
        return;
      }
      const authCode = url.searchParams.get("code");
      if (!authCode) {
        res.writeHead(400).end("Missing authorization code");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end(
          "<html><body>OpenWiki login complete, you can close this tab.</body></html>",
        );
      finish(authCode);
    });
    // Loopback only: never bind an unauthenticated code-capture endpoint publicly.
    server.listen(spec.callbackPort, "localhost", () => {
      openUrl(authUrl.toString());
      onReady?.({
        submitManual(rawInput) {
          const { code: manualCode, state: manualState } =
            parseManualCallbackInput(rawInput);
          if (!manualCode) {
            return "Could not find an authorization code in that input.";
          }
          if (manualState !== undefined && manualState !== state) {
            return "State mismatch, paste the URL from this login attempt.";
          }
          finish(manualCode);
          return undefined;
        },
      });
    });
    server.on("error", fail);
  });

  return postToken(spec, {
    grant_type: "authorization_code",
    client_id: spec.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
}

/**
 * Exchanges a refresh token for a fresh token response.
 */
export async function runOAuthRefresh(
  spec: OAuthFlowSpec,
  refreshToken: string,
): Promise<OAuthTokenResponse> {
  return postToken(spec, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: spec.clientId,
  });
}
