import { spawn } from "node:child_process";
import { saveOpenWikiEnv } from "../env.js";

const DEFAULT_CALLBACK_PORT = 53682;
const OAUTH_CALLBACK_PORT_ENV_KEY = "OPENWIKI_OAUTH_CALLBACK_PORT";
const OAUTH_REDIRECT_URI_ENV_KEY = "OPENWIKI_OAUTH_REDIRECT_URI";

export type NgrokStartOptions = {
  port?: number;
  url: string;
};

export type NgrokStartResult = {
  baseUrl: string;
  port: number;
  redirectUri: string;
};

export async function startNgrokTunnel({
  port = DEFAULT_CALLBACK_PORT,
  url,
}: NgrokStartOptions): Promise<NgrokStartResult> {
  const validatedPort = validatePort(port);
  const normalized = normalizeNgrokUrl(url);

  await saveOpenWikiEnv({
    [OAUTH_CALLBACK_PORT_ENV_KEY]: String(validatedPort),
    [OAUTH_REDIRECT_URI_ENV_KEY]: normalized.redirectUri,
  });

  process.stdout.write(
    [
      `Saved ${OAUTH_REDIRECT_URI_ENV_KEY}=${normalized.redirectUri}`,
      `Saved ${OAUTH_CALLBACK_PORT_ENV_KEY}=${validatedPort}`,
      `Register this Slack redirect URL: ${normalized.redirectUri}`,
      `Starting ngrok: ngrok http ${validatedPort} --url ${normalized.baseUrl}`,
      "",
    ].join("\n"),
  );

  await runNgrok(normalized.baseUrl, validatedPort);

  return {
    baseUrl: normalized.baseUrl,
    port: validatedPort,
    redirectUri: normalized.redirectUri,
  };
}

function normalizeNgrokUrl(value: string): {
  baseUrl: string;
  redirectUri: string;
} {
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    ? value
    : `https://${value}`;
  const url = new URL(withScheme);

  if (url.protocol !== "https:") {
    throw new Error("ngrok custom URL must use https.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "ngrok custom URL must not include credentials, query, or fragment.",
    );
  }

  if (url.port) {
    throw new Error("ngrok custom URL must not include a port.");
  }

  if (
    url.pathname !== "/" &&
    url.pathname !== "" &&
    url.pathname !== "/callback"
  ) {
    throw new Error("ngrok custom URL path must be empty or /callback.");
  }

  validateHostname(url.hostname);
  url.pathname = "";

  const baseUrl = url.toString().replace(/\/$/u, "");

  return {
    baseUrl,
    redirectUri: `${baseUrl}/callback`,
  };
}

function validateHostname(hostname: string): void {
  if (
    hostname.length > 253 ||
    !/^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u.test(
      hostname,
    )
  ) {
    throw new Error("ngrok custom URL must include a valid DNS hostname.");
  }
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("ngrok local port must be between 1024 and 65535.");
  }

  return port;
}

function runNgrok(baseUrl: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ngrok", ["http", String(port), "--url", baseUrl], {
      shell: false,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(
        new Error(
          error instanceof Error
            ? `Could not start ngrok: ${error.message}`
            : "Could not start ngrok.",
        ),
      );
    });
    child.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
        resolve();
        return;
      }

      reject(new Error(`ngrok exited with code=${code} signal=${signal}.`));
    });
  });
}
