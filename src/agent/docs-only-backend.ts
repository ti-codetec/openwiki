import {
  LocalShellBackend,
  type EditResult,
  type FileInfo,
  type LocalShellBackendOptions,
  type WriteResult,
} from "deepagents";
import { lstatSync, realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { OPEN_WIKI_DIR } from "../constants.js";
import type { OpenWikiOutputMode } from "./types.js";

export const MUTATION_PATH_METADATA_KEY = "openwikiMutationPath";

type OpenWikiBackendOptions = LocalShellBackendOptions & {
  docsOnly?: boolean;
  outputMode?: OpenWikiOutputMode;
};

export class OpenWikiLocalShellBackend extends LocalShellBackend {
  private readonly docsOnly: boolean;
  private readonly outputMode: OpenWikiOutputMode;
  private readonly rootDir: string;
  private readonly virtualModeEnabled: boolean;

  constructor(options: OpenWikiBackendOptions) {
    const rootDir = resolveCanonicalRoot(options.rootDir ?? process.cwd());
    super({ ...options, rootDir });
    this.docsOnly = options.docsOnly === true;
    this.outputMode = options.outputMode ?? "repository";
    this.rootDir = rootDir;
    this.virtualModeEnabled = options.virtualMode === true;
  }

  override async ls(filePath: string): Promise<{ files: FileInfo[] }> {
    const result = await this.safeLs(filePath);
    return { files: result.files };
  }

  /** Lists a virtual directory without following symlinks. */
  async safeLs(
    filePath: string,
  ): Promise<{ files: FileInfo[]; missing?: true }> {
    if (!this.virtualModeEnabled) {
      const result = await super.ls(filePath);
      if (result.error) throw new Error(result.error);
      return { files: result.files ?? [] };
    }
    const resolvedPath = this.resolveContainedPath(filePath);
    await this.assertNoSymlinkComponents(resolvedPath);

    let directoryStat;
    try {
      directoryStat = await lstat(resolvedPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return { files: [], missing: true };
      throw error;
    }
    if (!directoryStat.isDirectory()) return { files: [] };

    const entries = await readdir(resolvedPath, { withFileTypes: true });

    const files: FileInfo[] = [];
    for (const entry of entries) {
      const fullPath = path.join(resolvedPath, entry.name);
      const entryStat = await lstat(fullPath);
      if (entryStat.isSymbolicLink()) {
        throw new Error(
          `Symlinks are not allowed: ${this.toVirtualPath(fullPath)}`,
        );
      }
      if (!entryStat.isFile() && !entryStat.isDirectory()) continue;
      files.push({
        is_dir: entryStat.isDirectory(),
        modified_at: entryStat.mtime.toISOString(),
        path: `${this.toVirtualPath(fullPath)}${entryStat.isDirectory() ? "/" : ""}`,
        size: entryStat.isFile() ? entryStat.size : 0,
      });
    }
    files.sort((left, right) => compareCodeUnits(left.path, right.path));
    return { files };
  }

  override async readRaw(filePath: string) {
    if (this.virtualModeEnabled) {
      await this.assertNoSymlinkComponents(this.resolveContainedPath(filePath));
    }
    return super.readRaw(filePath);
  }

  override async write(
    filePath: string,
    content: string,
  ): Promise<WriteResult> {
    const error = this.getDocsOnlyWriteError(filePath);
    if (error) return { error };

    const containmentError = await this.getContainmentError(filePath);
    if (containmentError) return { error: containmentError };
    return markMutation(await super.write(filePath, content), filePath);
  }

  override async edit(
    filePath: string,
    oldString: string,
    newString: string,
    replaceAll?: boolean,
  ): Promise<EditResult> {
    const error = this.getDocsOnlyWriteError(filePath);
    if (error) return { error };

    const containmentError = await this.getContainmentError(filePath);
    if (containmentError) return { error: containmentError };
    return markMutation(
      await super.edit(filePath, oldString, newString, replaceAll),
      filePath,
    );
  }

  private getDocsOnlyWriteError(filePath: string): string | null {
    if (
      !this.docsOnly ||
      this.outputMode === "local-wiki" ||
      isOpenWikiDocsPath(filePath)
    ) {
      return null;
    }

    return `OpenWiki repository init/update runs may only write under /${OPEN_WIKI_DIR}/. Refused path: ${filePath}`;
  }

  private async getContainmentError(filePath: string): Promise<string | null> {
    if (!this.virtualModeEnabled) return null;
    try {
      await this.assertNoSymlinkComponents(this.resolveContainedPath(filePath));
      return null;
    } catch (error) {
      return `Refused path ${filePath}: ${errorMessage(error)}`;
    }
  }

  private resolveContainedPath(filePath: string): string {
    const normalized = filePath.trim().replaceAll("\\", "/");
    const virtualPath = normalized.startsWith("/")
      ? normalized
      : `/${normalized}`;
    if (virtualPath.split("/").includes("..") || virtualPath.startsWith("/~")) {
      throw new Error("Path traversal is not allowed.");
    }
    const resolved = path.resolve(this.rootDir, virtualPath.slice(1));
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path resolves outside root directory ${this.rootDir}.`);
    }
    return resolved;
  }

  private async assertNoSymlinkComponents(resolvedPath: string): Promise<void> {
    const filesystemRoot = path.parse(this.rootDir).root;
    const rootSegments = path
      .relative(filesystemRoot, this.rootDir)
      .split(path.sep)
      .filter(Boolean);
    let rootComponent = filesystemRoot;
    for (const segment of rootSegments) {
      rootComponent = path.join(rootComponent, segment);
      if ((await lstat(rootComponent)).isSymbolicLink()) {
        throw new Error(
          `Symlink root component is not allowed: ${rootComponent}`,
        );
      }
    }

    const relative = path.relative(this.rootDir, resolvedPath);
    const segments = relative.split(path.sep).filter(Boolean);
    let current = this.rootDir;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(
            `Symlink path component is not allowed: ${this.toVirtualPath(current)}`,
          );
        }
      } catch (error) {
        if (isErrno(error, "ENOENT")) return;
        throw error;
      }
    }
  }

  private toVirtualPath(hostPath: string): string {
    return `/${path.relative(this.rootDir, hostPath).split(path.sep).join("/")}`;
  }
}

function resolveCanonicalRoot(configuredRoot: string): string {
  const resolvedRoot = path.resolve(configuredRoot);
  const filesystemRoot = path.parse(resolvedRoot).root;
  const segments = path
    .relative(filesystemRoot, resolvedRoot)
    .split(path.sep)
    .filter(Boolean);
  let current = filesystemRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink root component is not allowed: ${current}`);
    }
  }
  return realpathSync(resolvedRoot);
}

/** Carries a successful mutation's file path into the ToolMessage metadata used by the validator. */
function markMutation<Result extends WriteResult | EditResult>(
  result: Result,
  filePath: string,
): Result {
  if (!result.error) {
    result.metadata = {
      ...result.metadata,
      [MUTATION_PATH_METADATA_KEY]: result.path ?? filePath,
    };
  }
  return result;
}

export function isOpenWikiDocsPath(filePath: string): boolean {
  const normalizedPath = filePath.trim().replace(/\\/gu, "/");
  const virtualPath = normalizedPath.replace(/^\/+/u, "");

  return (
    virtualPath === OPEN_WIKI_DIR || virtualPath.startsWith(`${OPEN_WIKI_DIR}/`)
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
