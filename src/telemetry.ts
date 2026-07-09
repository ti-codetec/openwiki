import { randomUUID } from "node:crypto";
import { mkdir, chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PostHog } from "posthog-node";

import type { OpenWikiCommand, OpenWikiOutputMode } from "./agent/types.js";
import { TELEMETRY_INIT_EVENT } from "./constants.js";
import { openWikiHomeDir } from "./openwiki-home.js";

/**
 * Which brain a run established. Mirrors the CLI's run modes.
 */
export type TelemetryMode = "code" | "personal";

/**
 * Options for recordInit, e.g. the --telemetry-file tee target.
 */
export type RecordInitOptions = {
  /**
   * When set, the payload (or a disabled marker) is written here as JSON.
   */
  telemetryFile?: string;
};

/**
 * The exact object handed to PostHog and, when requested, teed to disk.
 */
type InitEvent = {
  distinctId: string;
  event: string;
  properties: Record<string, unknown>;
};

/**
 * Location of the persistent, anonymous per-machine install id.
 */
const INSTALL_ID_PATH = path.join(openWikiHomeDir, "install-id");

/**
 * Default PostHog ingestion host; override with OPENWIKI_POSTHOG_HOST.
 */
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * Longest we will wait for the event to flush before letting the CLI exit.
 */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * One-time notice shown on the first init, in keeping with CLI norms.
 */
const FIRST_RUN_NOTICE = `
──── OpenWiki telemetry ──────────────────────────────────────
OpenWiki collects anonymous usage counts: which brain you initialize (code or
personal) and a random install ID. No file contents, repository data,
credentials, or personal information are ever sent.

Opt out anytime: set OPENWIKI_TELEMETRY_DISABLED=1 (or DO_NOT_TRACK=1) —
add it to ~/.openwiki/.env to make it permanent.
──────────────────────────────────────────────────────────────
`;

/**
 * True when the user has opted out via OpenWiki's own switch or the cross-tool
 * DO_NOT_TRACK convention. Both are read from process.env, which
 * loadOpenWikiEnv() has already populated from ~/.openwiki/.env — so a value
 * persisted in that file disables telemetry on every future run.
 */
export function isTelemetryDisabled(): boolean {
  return (
    isTruthyEnv(process.env.OPENWIKI_TELEMETRY_DISABLED) ||
    isTruthyEnv(process.env.DO_NOT_TRACK)
  );
}

/**
 * Treats "0", "false", and "" as not set; any other value as opted out.
 */
function isTruthyEnv(value?: string): boolean {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();

  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * True when the error is a plain missing-file condition.
 */
function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Resolves when `promise` settles or `ms` elapses, whichever comes first.
 */
async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
): Promise<void> {
  await Promise.race([
    promise.catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref();
    }),
  ]);
}

/**
 * Reads the persistent install id, creating it on first use. `isNew` is true
 * only when the id was just minted and is the signal used to show the one-time
 * notice. The id is a random UUID with no relationship to the user, machine, or
 * repository.
 */
export async function getOrCreateInstallId(): Promise<{
  id: string;
  isNew: boolean;
}> {
  try {
    const existing = (await readFile(INSTALL_ID_PATH, "utf8")).trim();

    if (existing.length > 0) {
      return { id: existing, isNew: false };
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error;
    }
  }

  const id = randomUUID();
  // Only the bare ~/.openwiki dir is needed for the install-id — not the
  // personal-brain scaffold (connectors/wiki/skills). This matches what the
  // agent checkpointer creates, so a code-mode init doesn't pull in a brain.
  await mkdir(openWikiHomeDir, { recursive: true, mode: 0o700 });
  await writeFile(INSTALL_ID_PATH, `${id}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(INSTALL_ID_PATH, 0o600);

  return { id, isNew: true };
}

/**
 * Sends the prebuilt init event to PostHog and flushes before returning.
 * Returns whether it actually sent (false when no project key is configured, so
 * an unconfigured build is a clean no-op). The CLI is short-lived, so shutdown()
 * is awaited — bounded by a timeout so a hung flush never wedges the process.
 */
async function captureInit(event: InitEvent): Promise<boolean> {
  const apiKey = process.env.OPENWIKI_POSTHOG_KEY;

  if (!apiKey) {
    return false;
  }

  const client = new PostHog(apiKey, {
    host: process.env.OPENWIKI_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
    flushAt: 1,
    flushInterval: 0,
  });

  client.capture(event);
  await withTimeout(client.shutdown(), FLUSH_TIMEOUT_MS);

  return true;
}

/**
 * Writes a record of the telemetry payload to a user-requested path. Because the
 * user explicitly asked for this file, a write failure surfaces a stderr warning
 * (it is not swallowed like the network send) — but it still never throws, so
 * the run is never affected. No-op when no path is given.
 */
async function writeTelemetryFile(
  filePath: string | undefined,
  record: Record<string, unknown>,
): Promise<void> {
  if (!filePath) {
    return;
  }

  try {
    const resolved = path.resolve(process.cwd(), filePath);
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // console.error so it renders cleanly above the live TUI (Ink patchConsole).
    console.error(
      `OpenWiki: could not write telemetry file "${filePath}": ${message}`,
    );
  }
}

/**
 * Decides whether a completed run should be recorded and, if so, which mode to
 * report. Telemetry fires only for `init` runs; `chat` and `update` return null.
 * outputMode is the mode proxy: "repository" = code, "local-wiki" = personal.
 * Extracted from the agent so the guard is unit-testable without a full run.
 */
export function initTelemetryMode(
  command: OpenWikiCommand,
  outputMode: OpenWikiOutputMode,
): TelemetryMode | null {
  if (command !== "init") {
    return null;
  }

  return outputMode === "repository" ? "code" : "personal";
}

/**
 * Shows the one-time first-run notice, if telemetry is enabled and this is the
 * first init on this machine (the install id was just minted). Called at the
 * START of an init run so the disclosure prints before any command output rather
 * than after it. Opt-out is absolute (no id minted, nothing printed) and it
 * never throws.
 */
export async function showFirstRunNoticeIfNeeded(): Promise<void> {
  if (isTelemetryDisabled()) {
    return;
  }

  try {
    const { isNew } = await getOrCreateInstallId();

    if (isNew) {
      // console.error (not raw stderr.write) so Ink's patchConsole renders it
      // cleanly above the live TUI; still goes to stderr on the plain path.
      console.error(FIRST_RUN_NOTICE);
    }
  } catch {
    // Intentionally ignored: telemetry must never break a run.
  }
}

/**
 * Records that a brain was initialized. Called only for `--init` runs, after the
 * run completes. Never throws: any failure (disabled, missing key, network,
 * filesystem) is swallowed so telemetry can never affect the run's outcome. The
 * event name encodes the mode (openwiki_init_code / openwiki_init_personal) so
 * it is visible in the raw event feed, with mode also kept as a property for
 * breakdowns.
 */
export async function recordInit(
  mode: TelemetryMode,
  options: RecordInitOptions = {},
): Promise<void> {
  if (isTelemetryDisabled()) {
    // Opt-out is absolute: no install id minted. The user-requested file still
    // gets an honest record that nothing was sent.
    await writeTelemetryFile(options.telemetryFile, {
      disabled: true,
      sent: false,
    });
    return;
  }

  try {
    const { id } = await getOrCreateInstallId();

    const event: InitEvent = {
      distinctId: id,
      event: `${TELEMETRY_INIT_EVENT}_${mode}`,
      properties: {
        mode,
        // Keep the event anonymous. No PostHog person profile, cheapest tier.
        $process_person_profile: false,
      },
    };
    const sent = await captureInit(event);

    await writeTelemetryFile(options.telemetryFile, {
      disabled: false,
      host: process.env.OPENWIKI_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
      sent,
      event,
    });
  } catch {
    // Intentionally ignored: telemetry must never break a run.
  }
}
