import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { validateOkfFrontmatter } from "../src/agent/frontmatter-validator.ts";

const originalHome = process.env.HOME;
const tempHomes: string[] = [];

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), "openwiki-onboarding-"));
  tempHomes.push(home);
  return home;
}

async function loadOnboardingModule(home: string) {
  vi.resetModules();
  process.env.HOME = home;
  return await import("../src/onboarding.ts");
}

afterEach(async () => {
  vi.resetModules();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  await Promise.all(
    tempHomes
      .splice(0)
      .map((home) => rm(home, { force: true, recursive: true })),
  );
});

describe("OpenWiki onboarding instructions", () => {
  test("saves wiki instructions to INSTRUCTIONS.md instead of onboarding.json", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      ingestionSchedule: {
        description: "daily",
        expression: "0 9 * * *",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      sourceInstances: [],
      sources: {},
      version: 1,
      wikiGoal: "Track projects, commitments, and recurring themes.",
    });

    const json = JSON.parse(
      await readFile(onboarding.openWikiOnboardingPath, "utf8"),
    ) as Record<string, unknown>;
    const instructions = await readFile(
      onboarding.openWikiInstructionsPath,
      "utf8",
    );

    expect(json.wikiGoal).toBeUndefined();
    expect(instructions).toBe(
      "Track projects, commitments, and recurring themes.\n",
    );
  });

  test("reads wiki instructions only from INSTRUCTIONS.md", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    await onboarding.saveOpenWikiOnboardingConfig({
      sourceInstances: [],
      sources: {},
      version: 1,
      wikiGoal: "Markdown instructions win.",
    });
    await writeFile(
      onboarding.openWikiOnboardingPath,
      `${JSON.stringify({
        sourceInstances: [],
        sources: {},
        version: 1,
        wikiGoal: "Legacy JSON fallback.",
      })}\n`,
      "utf8",
    );

    await expect(
      onboarding.readOpenWikiOnboardingConfig(),
    ).resolves.toMatchObject({
      wikiGoal: "Markdown instructions win.",
    });

    await rm(onboarding.openWikiInstructionsPath);

    const config = await onboarding.readOpenWikiOnboardingConfig();
    expect(config.wikiGoal).toBeUndefined();
  });

  test("saves repository wiki instructions under openwiki", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await onboarding.saveRepositoryWikiInstructions(
        repo,
        "Shared repository brief.",
      );

      const instructions = await readFile(
        onboarding.getRepositoryWikiInstructionsPath(repo),
        "utf8",
      );
      expect(instructions).toMatch(/^---\ntype: Repository guide\n/u);
      expect(instructions).toContain('openwiki_instructions: "1"\n');
      expect(instructions).toContain("title: Repository Wiki Instructions\n");
      expect(instructions).toContain("\n---\n\nShared repository brief.\n");
      expect(validateOkfFrontmatter(instructions)).toEqual({ valid: true });
      await expect(
        onboarding.readRepositoryWikiInstructions(repo),
      ).resolves.toBe("Shared repository brief.\n");
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test.each([
    "---\n\nFocus on public APIs.\n",
    "---\n\n---\nFocus on public APIs.\n",
  ])("does not strip legacy thematic-break instructions", async (body) => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      const instructionsPath =
        onboarding.getRepositoryWikiInstructionsPath(repo);
      await mkdir(path.dirname(instructionsPath), { recursive: true });
      await writeFile(instructionsPath, body, "utf8");

      await expect(
        onboarding.readRepositoryWikiInstructions(repo),
      ).resolves.toBe(body);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("treats parseable unmarked YAML at the start as legacy body byte for byte", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);
    const body =
      "---\ntype: User-authored example\ncustom: true\n---\n\nKeep this entire block.\n";
    try {
      const instructionsPath =
        onboarding.getRepositoryWikiInstructionsPath(repo);
      await mkdir(path.dirname(instructionsPath), { recursive: true });
      await writeFile(instructionsPath, body, "utf8");

      await expect(
        onboarding.readRepositoryWikiInstructions(repo),
      ).resolves.toBe(body);
      const migrated = onboarding.addRepositoryInstructionsFrontmatter(body);
      expect(migrated.endsWith(body)).toBe(true);
      expect(onboarding.isOpenWikiInstructionsDocument(migrated)).toBe(true);
      expect(onboarding.isOpenWikiInstructionsDocument(body)).toBe(false);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("preserves unknown scalar, list, and mapping extensions when saving instructions", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);
    try {
      await onboarding.saveRepositoryWikiInstructions(repo, "Initial brief.");
      const instructionsPath =
        onboarding.getRepositoryWikiInstructionsPath(repo);
      const current = await readFile(instructionsPath, "utf8");
      await writeFile(
        instructionsPath,
        current.replace(
          'openwiki_instructions: "1"\n',
          'openwiki_instructions: "1"\nconfidence: 0.75\nowners: [docs, platform]\nproducer:\n  name: catalog\n  enabled: true\n',
        ),
        "utf8",
      );

      await onboarding.saveRepositoryWikiInstructions(repo, "Updated brief.");

      const saved = await readFile(instructionsPath, "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(saved)?.[1];
      expect(parse(frontmatter ?? "")).toMatchObject({
        confidence: 0.75,
        owners: ["docs", "platform"],
        producer: { enabled: true, name: "catalog" },
      });
      await expect(
        onboarding.readRepositoryWikiInstructions(repo),
      ).resolves.toBe("Updated brief.\n");
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});

describe("OpenWiki onboarding completion", () => {
  test("does not require a schedule for code mode", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    expect(
      onboarding.isOnboardingComplete({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "code",
        sourceInstances: [],
        sources: {},
        templateId: "code",
        version: 1,
        wikiGoal: "Maintain a code wiki.",
      }),
    ).toBe(true);
  });

  test("checks repository instructions for completed code mode", async () => {
    const home = await createTempHome();
    const repo = await mkdtemp(path.join(tmpdir(), "openwiki-repo-"));
    const onboarding = await loadOnboardingModule(home);

    try {
      await onboarding.saveOpenWikiOnboardingConfig({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "code",
        sourceInstances: [],
        sources: {},
        templateId: "code",
        version: 1,
      });

      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        false,
      );

      await onboarding.saveRepositoryWikiInstructions(
        repo,
        "Maintain a shared code wiki.",
      );

      expect(onboarding.isRepositoryCodeOnboardingCompleteSync(repo)).toBe(
        true,
      );
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("still requires a schedule for personal mode", async () => {
    const home = await createTempHome();
    const onboarding = await loadOnboardingModule(home);

    expect(
      onboarding.isOnboardingComplete({
        completedAt: "2026-01-01T00:00:00.000Z",
        modeId: "personal",
        sourceInstances: [],
        sources: {},
        templateId: "personal",
        version: 1,
        wikiGoal: "Track projects and commitments.",
      }),
    ).toBe(false);
  });
});
