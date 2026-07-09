import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The module computes INSTALL_ID_PATH from openWikiHomeDir at import time, so we
// redirect the home dir to a temp location before importing the module under
// test. ensureOpenWikiHome is stubbed to mkdir that temp dir.
const TEST_HOME = path.join(os.tmpdir(), "openwiki-telemetry-test");
const INSTALL_ID_PATH = path.join(TEST_HOME, "install-id");
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

vi.mock("../src/openwiki-home.ts", () => ({
  openWikiHomeDir: TEST_HOME,
  ensureOpenWikiHome: vi.fn(async () => {
    await mkdir(TEST_HOME, { recursive: true, mode: 0o700 });
  }),
}));

// Stub the PostHog client so no network call is made. The captured constructor
// args, capture payload, and shutdown calls are asserted against these mocks.
const { ctorMock, captureMock, shutdownMock } = vi.hoisted(() => ({
  ctorMock: vi.fn(),
  captureMock: vi.fn(),
  shutdownMock: vi.fn(),
}));

vi.mock("posthog-node", () => ({
  // Must be a normal (constructable) function — the module uses `new PostHog()`,
  // and an arrow function throws "is not a constructor".
  PostHog: vi.fn(function PostHogMock(apiKey: string, options: unknown) {
    ctorMock(apiKey, options);

    return { capture: captureMock, shutdown: shutdownMock };
  }),
}));

const { ensureOpenWikiHome } = await import("../src/openwiki-home.ts");
const {
  getOrCreateInstallId,
  initTelemetryMode,
  isTelemetryDisabled,
  recordInit,
} = await import("../src/telemetry.ts");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const savedEnv = {
  OPENWIKI_TELEMETRY_DISABLED: process.env.OPENWIKI_TELEMETRY_DISABLED,
  DO_NOT_TRACK: process.env.DO_NOT_TRACK,
  OPENWIKI_POSTHOG_KEY: process.env.OPENWIKI_POSTHOG_KEY,
  OPENWIKI_POSTHOG_HOST: process.env.OPENWIKI_POSTHOG_HOST,
};

beforeEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
  vi.mocked(ensureOpenWikiHome).mockImplementation(async () => {
    await mkdir(TEST_HOME, { recursive: true, mode: 0o700 });
  });

  ctorMock.mockClear();
  captureMock.mockClear();
  shutdownMock.mockReset();
  shutdownMock.mockResolvedValue(undefined);

  for (const key of Object.keys(savedEnv)) {
    delete process.env[key];
  }
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(TEST_HOME, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    restoreEnv(key, value);
  }
});

describe("isTelemetryDisabled", () => {
  it("is false when neither opt-out variable is set", () => {
    expect(isTelemetryDisabled()).toBe(false);
  });

  it("treats 0, false, and empty string as not opted out", () => {
    for (const value of ["0", "false", "FALSE", "", "   "]) {
      process.env.OPENWIKI_TELEMETRY_DISABLED = value;
      expect(isTelemetryDisabled()).toBe(false);
    }
  });

  it("treats any other value of OPENWIKI_TELEMETRY_DISABLED as opted out", () => {
    for (const value of ["1", "true", "yes"]) {
      process.env.OPENWIKI_TELEMETRY_DISABLED = value;
      expect(isTelemetryDisabled()).toBe(true);
    }
  });

  it("honors the cross-tool DO_NOT_TRACK convention", () => {
    process.env.DO_NOT_TRACK = "1";
    expect(isTelemetryDisabled()).toBe(true);
  });
});

describe("initTelemetryMode", () => {
  it("maps code-mode inits (repository output) to code", () => {
    expect(initTelemetryMode("init", "repository")).toBe("code");
  });

  it("maps personal-mode inits (local-wiki output) to personal", () => {
    expect(initTelemetryMode("init", "local-wiki")).toBe("personal");
  });

  it("returns null for non-init runs so telemetry never fires", () => {
    expect(initTelemetryMode("chat", "repository")).toBeNull();
    expect(initTelemetryMode("chat", "local-wiki")).toBeNull();
    expect(initTelemetryMode("update", "repository")).toBeNull();
    expect(initTelemetryMode("update", "local-wiki")).toBeNull();
  });
});

describe("getOrCreateInstallId", () => {
  it("mints, persists, and 0600-protects a new id on first use", async () => {
    const result = await getOrCreateInstallId();

    expect(result.isNew).toBe(true);
    expect(result.id).toMatch(UUID_PATTERN);

    const fileStat = await stat(INSTALL_ID_PATH);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("returns the same id without re-minting on subsequent calls", async () => {
    const first = await getOrCreateInstallId();
    const second = await getOrCreateInstallId();

    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("re-mints when the stored file is blank", async () => {
    await mkdir(TEST_HOME, { recursive: true });
    await writeFile(INSTALL_ID_PATH, "   \n", "utf8");

    const result = await getOrCreateInstallId();

    expect(result.isNew).toBe(true);
    expect(result.id).toMatch(UUID_PATTERN);
  });

  it("propagates non-missing-file errors instead of minting a new id", async () => {
    // A directory at the id path makes readFile fail with EISDIR, not ENOENT.
    await mkdir(INSTALL_ID_PATH, { recursive: true });

    await expect(getOrCreateInstallId()).rejects.toThrow();
  });
});

describe("recordInit — local behavior", () => {
  it("writes nothing and prints nothing when opted out", async () => {
    process.env.DO_NOT_TRACK = "1";
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await recordInit("code");

    expect(writeSpy).not.toHaveBeenCalled();
    await expect(stat(INSTALL_ID_PATH)).rejects.toThrow();
    writeSpy.mockRestore();
  });

  it("prints the one-time notice on the first init only", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await recordInit("personal");
    expect(writeSpy).toHaveBeenCalledTimes(1);

    await recordInit("code");
    expect(writeSpy).toHaveBeenCalledTimes(1);

    writeSpy.mockRestore();
  });

  it("never throws when the underlying filesystem fails", async () => {
    // Make the id path a directory so the read/create both fail.
    await mkdir(INSTALL_ID_PATH, { recursive: true });
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(recordInit("code")).resolves.toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();

    writeSpy.mockRestore();
  });
});

describe("recordInit — PostHog capture", () => {
  it("sends exactly one anonymous openwiki_init event with the mode", async () => {
    process.env.OPENWIKI_POSTHOG_KEY = "phc_test";

    await recordInit("code");

    expect(ctorMock).toHaveBeenCalledWith("phc_test", {
      host: DEFAULT_POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    });

    expect(captureMock).toHaveBeenCalledTimes(1);

    // distinctId is the persisted install id, so counts dedupe per machine.
    const stored = (await readFile(INSTALL_ID_PATH, "utf8")).trim();
    expect(stored).toMatch(UUID_PATTERN);

    // The captured payload must be exactly this shape — nothing extra.
    expect(captureMock).toHaveBeenCalledWith({
      distinctId: stored,
      event: "openwiki_init",
      properties: {
        mode: "code",
        $process_person_profile: false,
      },
    });

    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it("uses OPENWIKI_POSTHOG_HOST when set", async () => {
    process.env.OPENWIKI_POSTHOG_KEY = "phc_test";
    process.env.OPENWIKI_POSTHOG_HOST = "https://eu.i.posthog.com";

    await recordInit("personal");

    expect(ctorMock).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ host: "https://eu.i.posthog.com" }),
    );
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: { mode: "personal", $process_person_profile: false },
      }),
    );
  });

  it("is a no-op with no client constructed when the key is absent", async () => {
    await recordInit("code");

    expect(ctorMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });

  it("returns within the flush timeout and never throws if shutdown hangs", async () => {
    process.env.OPENWIKI_POSTHOG_KEY = "phc_test";
    // A shutdown that never settles must still let the CLI exit: withTimeout's
    // real 2s timer wins the race. Real timers (not fake) so the actual
    // filesystem read and the timeout both run deterministically.
    shutdownMock.mockReturnValue(new Promise<void>(() => {}));

    await expect(recordInit("code")).resolves.toBeUndefined();
    expect(captureMock).toHaveBeenCalledTimes(1);
  }, 10000);
});

describe("recordInit — telemetry file (tee)", () => {
  const TEE_PATH = path.join(TEST_HOME, "telemetry.json");

  it("tees the exact sent payload when enabled with a key", async () => {
    process.env.OPENWIKI_POSTHOG_KEY = "phc_test";

    await recordInit("code", { telemetryFile: TEE_PATH });

    const record = JSON.parse(await readFile(TEE_PATH, "utf8")) as {
      disabled: boolean;
      sent: boolean;
      host: string;
      event: { distinctId: string; event: string; properties: unknown };
    };
    expect(record.disabled).toBe(false);
    expect(record.sent).toBe(true);
    expect(record.host).toBe(DEFAULT_POSTHOG_HOST);
    expect(record.event.event).toBe("openwiki_init");
    expect(record.event.distinctId).toMatch(UUID_PATTERN);
    expect(record.event.properties).toEqual({
      mode: "code",
      $process_person_profile: false,
    });

    // The teed payload must match what PostHog actually received.
    expect(captureMock).toHaveBeenCalledWith(record.event);
  });

  it("records the would-be payload with sent:false when no key is set", async () => {
    await recordInit("personal", { telemetryFile: TEE_PATH });

    const record = JSON.parse(await readFile(TEE_PATH, "utf8")) as {
      disabled: boolean;
      sent: boolean;
      event: { properties: { mode: string } };
    };
    expect(record.disabled).toBe(false);
    expect(record.sent).toBe(false);
    expect(record.event.properties.mode).toBe("personal");
    expect(ctorMock).not.toHaveBeenCalled();
  });

  it("writes a disabled marker and mints no install id when opted out", async () => {
    process.env.DO_NOT_TRACK = "1";

    await recordInit("code", { telemetryFile: TEE_PATH });

    const record = JSON.parse(await readFile(TEE_PATH, "utf8")) as {
      disabled: boolean;
      sent: boolean;
    };
    expect(record).toEqual({ disabled: true, sent: false });
    await expect(stat(INSTALL_ID_PATH)).rejects.toThrow();
    expect(ctorMock).not.toHaveBeenCalled();
  });

  it("warns on stderr but never throws when the file cannot be written", async () => {
    process.env.OPENWIKI_POSTHOG_KEY = "phc_test";
    // Pre-seed the id so no notice noise, then point the tee at a directory so
    // writeFile fails with EISDIR.
    await mkdir(TEST_HOME, { recursive: true });
    await writeFile(INSTALL_ID_PATH, "seeded-id\n", "utf8");
    const dirTarget = path.join(TEST_HOME, "not-a-file");
    await mkdir(dirTarget, { recursive: true });
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      recordInit("code", { telemetryFile: dirTarget }),
    ).resolves.toBeUndefined();

    expect(
      writeSpy.mock.calls.some((call) =>
        String(call[0]).includes("could not write telemetry file"),
      ),
    ).toBe(true);
    writeSpy.mockRestore();
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
