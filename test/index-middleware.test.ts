import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { BackendProtocolV2 } from "deepagents";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { OpenWikiLocalShellBackend } from "../src/agent/docs-only-backend.ts";
import { validateOkfFrontmatter } from "../src/agent/frontmatter-validator.ts";
import { synchronizeWikiIndexes } from "../src/agent/index-middleware.ts";

function document(title: string, description: string): string {
  return `---\ntype: Reference\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n`;
}

async function setup(outputMode: "local-wiki" | "repository" = "repository") {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-index-"));
  const backend = new OpenWikiLocalShellBackend({
    docsOnly: true,
    outputMode,
    rootDir,
    virtualMode: true,
  });
  return { backend, rootDir };
}

describe("synchronizeWikiIndexes", () => {
  test("creates deterministic indexes for every directory", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/quickstart.md",
      document("Quickstart", "Start here."),
    );
    await backend.write(
      "/openwiki/architecture/overview.md",
      document("Architecture overview", "How the system is structured."),
    );

    await synchronizeWikiIndexes(backend, "repository");

    const rootIndex = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    const architectureIndex = await readFile(
      path.join(rootDir, "openwiki/architecture/index.md"),
      "utf8",
    );

    expect(rootIndex).toMatch(/^---\nokf_version: "0\.1"\n---\n\n# Files\n/u);
    expect(rootIndex).not.toContain("type: Documentation Index");
    expect(architectureIndex).toMatch(/^# Files\n/u);
    expect(architectureIndex).not.toMatch(/^---/u);
    expect(rootIndex).toContain("- [Quickstart](quickstart.md) - Start here.");
    expect(rootIndex).toContain(
      "# Directories\n\n- [architecture](architecture/)",
    );
    expect(rootIndex).not.toContain("architecture/) -");
    expect(architectureIndex).toContain(
      "- [Architecture overview](overview.md) - How the system is structured.",
    );
  });

  test("does not rewrite an index that is already current", async () => {
    const { backend } = await setup();
    await backend.write(
      "/openwiki/page.md",
      document("Page", "A stable page."),
    );
    await synchronizeWikiIndexes(backend, "repository");

    const edit = vi.spyOn(backend, "edit");
    await synchronizeWikiIndexes(backend, "repository");
    expect(edit).not.toHaveBeenCalled();
  });

  test("repairs stale indexes and handles instructions and reserved Markdown", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      document("Page", "Current description."),
    );
    const legacyInstructions = "  Legacy repository brief.\n\n";
    await backend.write("/openwiki/INSTRUCTIONS.md", legacyInstructions);
    await backend.write(
      "/openwiki/log.md",
      "# Directory Update Log\n\n## 2026-07-16\n\n- **Update**: Refreshed docs.\n",
    );
    await synchronizeWikiIndexes(backend, "repository");

    const indexPath = "/openwiki/index.md";
    const current = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    await backend.edit(indexPath, current, "stale");
    await synchronizeWikiIndexes(backend, "repository");

    const repaired = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(repaired).toContain("Current description.");
    expect(repaired).toContain(
      "- [Repository Wiki Instructions](INSTRUCTIONS.md) - Shared, user-authored guidance for creating and maintaining this repository's OpenWiki documentation.",
    );
    expect(repaired).not.toContain("log.md");

    const migratedInstructions = await readFile(
      path.join(rootDir, "openwiki/INSTRUCTIONS.md"),
      "utf8",
    );
    expect(validateOkfFrontmatter(migratedInstructions)).toEqual({
      valid: true,
    });
    expect(
      migratedInstructions.endsWith(`\n---\n\n${legacyInstructions}`),
    ).toBe(true);
  });

  test.each([
    "---\n\nFocus on public APIs.\n",
    "---\n\n---\nFocus on public APIs.\n",
  ])("migrates thematic-break-prefixed legacy instructions", async (body) => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/INSTRUCTIONS.md", body);

    await synchronizeWikiIndexes(backend, "repository");

    const migrated = await readFile(
      path.join(rootDir, "openwiki/INSTRUCTIONS.md"),
      "utf8",
    );
    expect(validateOkfFrontmatter(migrated)).toEqual({ valid: true });
    expect(migrated.endsWith(`\n---\n\n${body}`)).toBe(true);
  });

  test.each([
    ["/openwiki/page.md", "---\ntitle: Missing type\n---\n", "missing_type"],
    [
      "/openwiki/.hidden.md",
      "---\ntitle: Hidden missing type\n---\n",
      "missing_type",
    ],
    [
      "/openwiki/.hidden/page.md",
      "---\ntitle: Nested hidden missing type\n---\n",
      "missing_type",
    ],
    ["/openwiki/log.md", "# Invalid log\n", "missing_log_heading"],
    [
      "/openwiki/_plan.md",
      document("Temporary plan", "Must be removed."),
      "Temporary plan",
    ],
  ])(
    "rejects a nonconformant final bundle file: %s",
    async (file, content, issue) => {
      const { backend } = await setup();
      await backend.write(file, content);

      await expect(
        synchronizeWikiIndexes(backend, "repository"),
      ).rejects.toThrow(issue);
    },
  );

  test("indexes a valid OKF file without an optional description", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      "---\ntype: Reference\ntitle: Page\n---\n",
    );

    await synchronizeWikiIndexes(backend, "repository");

    const index = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(index).toContain("- [Page](page.md)\n");
    expect(index).not.toContain("undefined");
  });

  test("parses quoted and folded YAML descriptions", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/quoted.md",
      "---\ntype: Reference\ntitle: 'Quoted: page'\ndescription: \"A description: with a colon.\"\n---\n",
    );
    await backend.write(
      "/openwiki/folded.md",
      "---\ntype: Reference\ntitle: Folded\ndescription: >-\n  A folded\n  description.\n---\n",
    );

    await synchronizeWikiIndexes(backend, "repository");

    const index = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(index).toContain(
      "- [Quoted: page](quoted.md) - A description: with a colon.",
    );
    expect(index).toContain("- [Folded](folded.md) - A folded description.");
  });

  test("collapses multiline index metadata so it cannot inject Markdown structure", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/page.md",
      "---\ntype: Reference\ntitle: |-\n  Safe title\n  # Injected title\ndescription: |-\n  Safe description.\n  # Injected section\n  - injected item\n---\n",
    );

    await synchronizeWikiIndexes(backend, "repository");

    const index = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(index).toContain(
      "- [Safe title # Injected title](page.md) - Safe description. # Injected section - injected item",
    );
    expect(index).not.toContain("\n# Injected");
  });

  test("rejects malformed and duplicate YAML", async () => {
    for (const frontmatter of [
      "type: [unterminated\ndescription: Page",
      "type: Reference\ndescription: First\ndescription: Second",
    ]) {
      const { backend } = await setup();
      await backend.write("/openwiki/page.md", `---\n${frontmatter}\n---\n`);

      await expect(
        synchronizeWikiIndexes(backend, "repository"),
      ).rejects.toThrow(
        "/openwiki/page.md contains invalid YAML front matter:",
      );
    }
  });

  test.each(["123", "[one, two]", "{ text: nested }"])(
    "rejects a non-string YAML description: %s",
    async (description) => {
      const { backend } = await setup();
      await backend.write(
        "/openwiki/page.md",
        `---\ntype: Reference\ndescription: ${description}\n---\n`,
      );

      await expect(
        synchronizeWikiIndexes(backend, "repository"),
      ).rejects.toThrow(
        "/openwiki/page.md YAML description must be a non-empty string.",
      );
    },
  );

  test("supports the local wiki root and empty directories", async () => {
    const { backend, rootDir } = await setup("local-wiki");
    await backend.write(
      "/quickstart.md",
      document("Quickstart", "Start here."),
    );
    await mkdir(path.join(rootDir, "empty"));

    await synchronizeWikiIndexes(backend, "local-wiki");

    await expect(
      readFile(path.join(rootDir, "index.md"), "utf8"),
    ).resolves.toContain("- [empty](empty/)");
    await expect(
      readFile(path.join(rootDir, "empty/index.md"), "utf8"),
    ).resolves.toBe("# Files\n");
  });

  test("validates Markdown below hidden directories without writing hidden indexes", async () => {
    const { backend, rootDir } = await setup();
    await backend.write(
      "/openwiki/.hidden/page.md",
      document("Hidden page", "Hidden but conformant."),
    );
    await mkdir(path.join(rootDir, "openwiki/.control"));

    await synchronizeWikiIndexes(backend, "repository");

    await expect(
      readFile(path.join(rootDir, "openwiki/.hidden/index.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(rootDir, "openwiki/.control/index.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(rootDir, "openwiki/index.md"), "utf8"),
    ).resolves.toContain("[.hidden](.hidden/)");
  });

  test("preserves a conformant index owned by hidden tooling", async () => {
    const { backend, rootDir } = await setup();
    const toolingIndex = "# Tooling\n\n- [Settings](settings.md)\n";
    await backend.write("/openwiki/.tool/index.md", toolingIndex);

    await synchronizeWikiIndexes(backend, "repository");

    await expect(
      readFile(path.join(rootDir, "openwiki/.tool/index.md"), "utf8"),
    ).resolves.toBe(toolingIndex);
  });

  test("rejects an invalid hidden tooling index without rewriting it", async () => {
    const { backend, rootDir } = await setup();
    const toolingIndex = "# Tooling\n\nUnexpected paragraph.\n";
    await backend.write("/openwiki/.tool/index.md", toolingIndex);

    await expect(synchronizeWikiIndexes(backend, "repository")).rejects.toThrow(
      "unexpected_index_content",
    );
    await expect(
      readFile(path.join(rootDir, "openwiki/.tool/index.md"), "utf8"),
    ).resolves.toBe(toolingIndex);
  });

  test.each(["INDEX.md", "LOG.md", "_PLAN.md", ".GIT"])(
    "fails before writing when a portable reserved-name collision exists: %s",
    async (name) => {
      const { backend, rootDir } = await setup();
      if (name === ".GIT") {
        await mkdir(path.join(rootDir, "openwiki", name), { recursive: true });
      } else {
        await backend.write(
          `/openwiki/${name}`,
          document("Collision", "Portable collision."),
        );
      }

      await expect(
        synchronizeWikiIndexes(backend, "repository"),
      ).rejects.toThrow(/case-insensitive.*collision/iu);
      await expect(
        readFile(path.join(rootDir, "openwiki/index.md"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("sorts indexes by code units without consulting the host locale", async () => {
    const { backend, rootDir } = await setup();
    await backend.write("/openwiki/a.md", document("a", "Lowercase."));
    await backend.write("/openwiki/B.md", document("B", "Uppercase."));
    const localeCompare = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("locale-dependent comparator used");
      });
    try {
      await synchronizeWikiIndexes(backend, "repository");
    } finally {
      localeCompare.mockRestore();
    }

    const index = await readFile(
      path.join(rootDir, "openwiki/index.md"),
      "utf8",
    );
    expect(index.indexOf("(B.md)")).toBeLessThan(index.indexOf("(a.md)"));
  });

  test("tolerates only a root that the safe backend proves absent", async () => {
    const { backend, rootDir } = await setup();

    await expect(
      synchronizeWikiIndexes(backend, "repository"),
    ).resolves.toBeUndefined();
    await expect(
      readFile(path.join(rootDir, "openwiki/index.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("fails closed on an unsafe root listing result", async () => {
    const backend = {
      ls: vi.fn(() => Promise.resolve({ error: "EACCES: permission denied" })),
    } as unknown as BackendProtocolV2;

    await expect(synchronizeWikiIndexes(backend, "repository")).rejects.toThrow(
      "EACCES",
    );
  });

  test("rejects external directory symlinks and cycles without touching targets", async () => {
    const { backend, rootDir } = await setup();
    const outside = await mkdtemp(path.join(os.tmpdir(), "openwiki-outside-"));
    await writeFile(
      path.join(outside, "outside.md"),
      document("Outside", "Must not be traversed."),
      "utf8",
    );
    await mkdir(path.join(rootDir, "openwiki"), { recursive: true });
    await symlink(outside, path.join(rootDir, "openwiki/external"), "dir");

    await expect(synchronizeWikiIndexes(backend, "repository")).rejects.toThrow(
      /symlink/iu,
    );
    await expect(
      readFile(path.join(outside, "index.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await unlink(path.join(rootDir, "openwiki/external"));
    await symlink(".", path.join(rootDir, "openwiki/cycle"), "dir");
    await expect(synchronizeWikiIndexes(backend, "repository")).rejects.toThrow(
      /symlink/iu,
    );
  });

  test("does not migrate nested or personal INSTRUCTIONS.md files", async () => {
    const repository = await setup();
    await repository.backend.write(
      "/openwiki/nested/INSTRUCTIONS.md",
      "Legacy nested body.\n",
    );
    await expect(
      synchronizeWikiIndexes(repository.backend, "repository"),
    ).rejects.toThrow("lacks YAML front matter");
    await expect(
      readFile(
        path.join(repository.rootDir, "openwiki/nested/INSTRUCTIONS.md"),
        "utf8",
      ),
    ).resolves.toBe("Legacy nested body.\n");

    const personal = await setup("local-wiki");
    await personal.backend.write("/INSTRUCTIONS.md", "Legacy personal body.\n");
    await expect(
      synchronizeWikiIndexes(personal.backend, "local-wiki"),
    ).rejects.toThrow("lacks YAML front matter");
    await expect(
      readFile(path.join(personal.rootDir, "INSTRUCTIONS.md"), "utf8"),
    ).resolves.toBe("Legacy personal body.\n");
  });
});
