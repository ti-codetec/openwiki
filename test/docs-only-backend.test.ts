import type { Dirent, PathLike, Stats } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isOpenWikiDocsPath,
  MUTATION_PATH_METADATA_KEY,
  OpenWikiLocalShellBackend,
} from "../src/agent/docs-only-backend.ts";

const fsMocks = vi.hoisted(() => ({
  actualLstat: undefined as
    ((filePath: PathLike) => Promise<Stats>) | undefined,
  actualReaddir: undefined as
    | ((
        filePath: PathLike,
        options: { withFileTypes: true },
      ) => Promise<Dirent[]>)
    | undefined,
  lstat: vi.fn<(filePath: PathLike) => Promise<Stats>>(),
  readdir:
    vi.fn<
      (
        filePath: PathLike,
        options: { withFileTypes: true },
      ) => Promise<Dirent[]>
    >(),
}));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  fsMocks.actualLstat = (filePath) => actual.lstat(filePath);
  fsMocks.actualReaddir = (filePath, options) =>
    actual.readdir(filePath, options);
  fsMocks.lstat.mockImplementation(fsMocks.actualLstat);
  fsMocks.readdir.mockImplementation(fsMocks.actualReaddir);
  return {
    ...actual,
    lstat: fsMocks.lstat,
    readdir: fsMocks.readdir,
  };
});

afterEach(() => {
  fsMocks.lstat.mockReset();
  fsMocks.lstat.mockImplementation(fsMocks.actualLstat!);
  fsMocks.readdir.mockReset();
  fsMocks.readdir.mockImplementation(fsMocks.actualReaddir!);
});

describe("OpenWikiLocalShellBackend", () => {
  test("recognizes only openwiki virtual paths as docs paths", () => {
    expect(isOpenWikiDocsPath("/openwiki/architecture.md")).toBe(true);
    expect(isOpenWikiDocsPath("openwiki/architecture.md")).toBe(true);
    expect(isOpenWikiDocsPath("\\openwiki\\operations.md")).toBe(true);
    expect(isOpenWikiDocsPath("/penwiki/architecture.md")).toBe(false);
    expect(isOpenWikiDocsPath("/AGENTS.md")).toBe(false);
    expect(isOpenWikiDocsPath("/home/runner/openwiki/architecture.md")).toBe(
      false,
    );
  });

  test("refuses init/update writes outside openwiki", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      rootDir,
      virtualMode: true,
    });

    const write = await backend.write("/openwiki/architecture.md", "ok");
    expect(write).toEqual(
      expect.objectContaining({ path: "/openwiki/architecture.md" }),
    );
    expect(write.metadata?.[MUTATION_PATH_METADATA_KEY]).toBe(
      "/openwiki/architecture.md",
    );
    await expect(
      readFile(path.join(rootDir, "openwiki/architecture.md"), "utf8"),
    ).resolves.toBe("ok");

    const penwikiWrite = await backend.write("/penwiki/architecture.md", "bad");
    expect(penwikiWrite.error).toContain(
      "Refused path: /penwiki/architecture.md",
    );
    expect(penwikiWrite.metadata).toBeUndefined();

    const agentsEdit = await backend.edit("/AGENTS.md", "old", "new");
    expect(agentsEdit.error).toContain("Refused path: /AGENTS.md");
  });

  test("allows local-wiki init/update writes at the wiki virtual root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "local-wiki",
      rootDir,
      virtualMode: true,
    });

    const write = await backend.write("/quickstart.md", "ok");
    expect(write).toEqual(expect.objectContaining({ path: "/quickstart.md" }));
    const edit = await backend.edit("/quickstart.md", "ok", "updated");
    expect(edit.metadata?.[MUTATION_PATH_METADATA_KEY]).toBe("/quickstart.md");
    await expect(
      readFile(path.join(rootDir, "quickstart.md"), "utf8"),
    ).resolves.toBe("updated");
  });

  test("keeps chat-mode style backends unrestricted when docsOnly is false", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: false,
      rootDir,
      virtualMode: true,
    });

    await expect(backend.write("/notes.md", "ok")).resolves.toEqual(
      expect.objectContaining({ path: "/notes.md" }),
    );
    await expect(
      readFile(path.join(rootDir, "notes.md"), "utf8"),
    ).resolves.toBe("ok");
  });

  test("refuses reads and writes through symlinked parents outside the backend root", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-outside-"),
    );
    await mkdir(path.join(rootDir, "openwiki"));
    await writeFile(path.join(outsideDir, "outside.md"), "outside", "utf8");
    await symlink(outsideDir, path.join(rootDir, "openwiki/link"), "dir");
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir,
      virtualMode: true,
    });

    await expect(backend.readRaw("/openwiki/link/outside.md")).rejects.toThrow(
      /symlink/iu,
    );
    const write = await backend.write("/openwiki/link/created.md", "escaped");
    expect(write.error).toMatch(/symlink/iu);
    await expect(
      readFile(path.join(outsideDir, "created.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses configured root paths containing a symlink component", async () => {
    const outsideDir = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-outside-"),
    );
    const aliasParent = await mkdtemp(
      path.join(os.tmpdir(), "openwiki-alias-"),
    );
    const rootAlias = path.join(aliasParent, "root");
    await symlink(outsideDir, rootAlias, "dir");

    const writeThrough = async (rootDir: string) => {
      const backend = new OpenWikiLocalShellBackend({
        docsOnly: true,
        outputMode: "repository",
        rootDir,
        virtualMode: true,
      });
      return backend.write("/openwiki/escaped.md", "escaped");
    };

    await expect(writeThrough(rootAlias)).rejects.toThrow(/symlink/iu);
    await expect(
      readFile(path.join(outsideDir, "openwiki/escaped.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const repositoryDir = path.join(outsideDir, "repository");
    await mkdir(repositoryDir);
    const ancestorAlias = path.join(aliasParent, "ancestor");
    await symlink(outsideDir, ancestorAlias, "dir");
    await expect(
      writeThrough(path.join(ancestorAlias, "repository")),
    ).rejects.toThrow(/symlink/iu);
    await expect(
      readFile(path.join(repositoryDir, "openwiki/escaped.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("safe directory listing distinguishes absence from other failures", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir,
      virtualMode: true,
    });

    await expect(backend.safeLs("/openwiki")).resolves.toEqual({
      files: [],
      missing: true,
    });
  });

  test("safe directory listing fails closed when the directory disappears after lstat", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const wikiDir = path.join(rootDir, "openwiki");
    await mkdir(wikiDir);
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir,
      virtualMode: true,
    });
    fsMocks.readdir.mockImplementation(async (filePath, options) => {
      if (path.resolve(filePath.toString()) === wikiDir) {
        throw Object.assign(new Error("directory vanished"), {
          code: "ENOENT",
        });
      }
      return fsMocks.actualReaddir!(filePath, options);
    });

    await expect(backend.safeLs("/openwiki")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("safe directory listing fails closed when a child disappears after readdir", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-backend-"));
    const wikiDir = path.join(rootDir, "openwiki");
    const vanishedChild = path.join(wikiDir, "vanished.md");
    await mkdir(wikiDir);
    await writeFile(vanishedChild, "temporary", "utf8");
    const backend = new OpenWikiLocalShellBackend({
      docsOnly: true,
      outputMode: "repository",
      rootDir,
      virtualMode: true,
    });
    fsMocks.lstat.mockImplementation(async (filePath) => {
      if (path.resolve(filePath.toString()) === vanishedChild) {
        throw Object.assign(new Error("child vanished"), { code: "ENOENT" });
      }
      return fsMocks.actualLstat!(filePath);
    });

    await expect(backend.safeLs("/openwiki")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
