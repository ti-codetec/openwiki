import type { BackendProtocolV2, FileInfo } from "deepagents";
import { createMiddleware } from "langchain";
import path from "node:path";
import { parse } from "yaml";
import {
  addRepositoryInstructionsFrontmatter,
  isOpenWikiInstructionsDocument,
  REPOSITORY_INSTRUCTIONS_FILE,
} from "../onboarding.js";
import {
  addFrontmatterWarning,
  type FrontmatterValidation,
  validateOkfFrontmatter,
  validateOkfIndex,
  validateOkfLog,
} from "./frontmatter-validator.js";
import type { OpenWikiOutputMode } from "./types.js";

const INDEX_FILE = "index.md";
const IGNORED_DIRECTORY = ".git";
const LOG_FILE = "log.md";
const PLAN_FILE = "_plan.md";
const PORTABLE_RESERVED_NAMES = new Map([
  [INDEX_FILE, INDEX_FILE],
  [LOG_FILE, LOG_FILE],
  [PLAN_FILE, PLAN_FILE],
  [IGNORED_DIRECTORY, IGNORED_DIRECTORY],
]);

interface Directory {
  entries: FileInfo[];
  path: string;
}
interface Link {
  description?: string;
  href: string;
  label: string;
}
interface PendingWrite {
  content: string;
  existing: string | null;
  path: string;
  purpose: string;
}

type SafeListing = { error?: string; files?: FileInfo[]; missing?: boolean };

/** Creates middleware that validates writes and synchronizes deterministic indexes after a run. */
export function createOpenWikiIndexMiddleware(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
) {
  return createMiddleware({
    name: "OpenWikiIndexMiddleware",
    wrapToolCall: async (request, handler) =>
      addFrontmatterWarning(
        await handler(request),
        backend,
        outputMode,
        request.toolCall.name,
      ),
    afterAgent: async () => {
      await synchronizeWikiIndexes(backend, outputMode);
    },
  });
}

/** Validates the complete wiki, then applies migrations and deterministic indexes. */
export async function synchronizeWikiIndexes(
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
): Promise<void> {
  const root = outputMode === "local-wiki" ? "/" : "/openwiki";
  const directories = await collectDirectories(backend, root, true);
  const writes: PendingWrite[] = [];
  for (const directory of directories) {
    writes.push(
      ...(await prepareDirectory(backend, directory, root, outputMode)),
    );
  }
  for (const write of writes) {
    const result =
      write.existing === null
        ? await backend.write(write.path, write.content)
        : await backend.edit(write.path, write.existing, write.content);
    if (result.error) {
      throw new Error(
        `Unable to ${write.purpose} ${write.path}: ${result.error}`,
      );
    }
  }
}

/** Recursively collects wiki directories while rejecting unsafe portable names. */
async function collectDirectories(
  backend: BackendProtocolV2,
  directoryPath: string,
  allowMissing = false,
): Promise<Directory[]> {
  const result = await listSafely(backend, directoryPath);
  if (result.missing) {
    if (allowMissing) return [];
    throw new Error(`Unable to list ${directoryPath}: path does not exist.`);
  }
  if (result.error) {
    throw new Error(`Unable to list ${directoryPath}: ${result.error}`);
  }

  const entries = result.files ?? [];
  assertNoPortableReservedCollisions(directoryPath, entries);
  const children = entries.filter(
    (entry) => entry.is_dir && entryName(entry) !== IGNORED_DIRECTORY,
  );
  const descendants = await Promise.all(
    children.map((entry) => {
      const name = entryName(entry);
      return collectDirectories(backend, path.posix.join(directoryPath, name));
    }),
  );
  return [
    ...descendants.flat(),
    {
      entries,
      path: directoryPath,
    },
  ];
}

async function listSafely(
  backend: BackendProtocolV2,
  directoryPath: string,
): Promise<SafeListing> {
  const safeBackend = backend as BackendProtocolV2 & {
    safeLs?: (path: string) => Promise<SafeListing>;
  };
  return safeBackend.safeLs
    ? safeBackend.safeLs(directoryPath)
    : backend.ls(directoryPath);
}

function assertNoPortableReservedCollisions(
  directoryPath: string,
  entries: FileInfo[],
): void {
  for (const entry of entries) {
    const name = entryName(entry);
    const canonical = PORTABLE_RESERVED_NAMES.get(name.toLowerCase());
    if (canonical && name !== canonical) {
      throw new Error(
        `Portable case-insensitive reserved-name collision in ${directoryPath}: ${name} conflicts with ${canonical}.`,
      );
    }
  }
}

/** Validates one directory and prepares, but does not perform, its writes. */
async function prepareDirectory(
  backend: BackendProtocolV2,
  directory: Directory,
  root: string,
  outputMode: OpenWikiOutputMode,
): Promise<PendingWrite[]> {
  const files: Link[] = [];
  const directories: Link[] = [];
  const writes: PendingWrite[] = [];
  const hiddenDirectory = isHiddenDirectory(directory.path, root);

  for (const entry of directory.entries) {
    const name = entryName(entry);
    if (!name) continue;

    if (entry.is_dir) {
      if (name === IGNORED_DIRECTORY) continue;
      directories.push({ href: `${encodeURIComponent(name)}/`, label: name });
      continue;
    }
    if (path.posix.extname(name).toLowerCase() !== ".md") continue;

    const filePath = path.posix.join(directory.path, name);
    if (name === INDEX_FILE) {
      if (hiddenDirectory) {
        assertValidOkf(
          filePath,
          validateOkfIndex(await readText(backend, filePath)),
        );
      }
      continue;
    }
    if (name === PLAN_FILE) {
      throw new Error(
        `Temporary plan ${filePath} must be removed before completion.`,
      );
    }

    let content = await readText(backend, filePath);
    if (name === LOG_FILE) {
      assertValidOkf(filePath, validateOkfLog(content));
      continue;
    }
    const isRootRepositoryInstructions =
      outputMode === "repository" &&
      directory.path === root &&
      name === REPOSITORY_INSTRUCTIONS_FILE;
    if (
      isRootRepositoryInstructions &&
      !isOpenWikiInstructionsDocument(content)
    ) {
      const migrated = addRepositoryInstructionsFrontmatter(content);
      writes.push({
        content: migrated,
        existing: content,
        path: filePath,
        purpose: "migrate legacy instructions",
      });
      content = migrated;
    }
    const metadata = parseFrontmatter(content, filePath);
    assertValidOkf(filePath, validateOkfFrontmatter(content));
    files.push({
      description: metadata.description,
      href: encodeURIComponent(name),
      label: metadata.title ?? path.posix.basename(name, ".md"),
    });
  }

  if (hiddenDirectory) return writes;

  const indexPath = path.posix.join(directory.path, INDEX_FILE);
  const content = renderIndex(files, directories, directory.path === root);
  const existing = directory.entries.some(
    (entry) => !entry.is_dir && entryName(entry) === INDEX_FILE,
  )
    ? await readText(backend, indexPath)
    : null;
  if (existing !== content) {
    writes.push({
      content,
      existing,
      path: indexPath,
      purpose: existing === null ? "write" : "update",
    });
  }
  return writes;
}

function isHiddenDirectory(directoryPath: string, root: string): boolean {
  if (directoryPath === root) return false;
  return directoryPath
    .slice(root.length)
    .split("/")
    .filter(Boolean)
    .some((segment) => segment.startsWith("."));
}

/** Throws an actionable final-bundle error for invalid OKF content. */
function assertValidOkf(
  filePath: string,
  validation: FrontmatterValidation,
): void {
  if (validation.valid) return;
  const details = validation.issues
    .map(
      ({ code, line, message }) =>
        `[${code}]${line ? ` line ${line}:` : ""} ${message}`,
    )
    .join("; ");
  throw new Error(`${filePath} is not valid OKF: ${details}`);
}

/** Renders a complete deterministic index document. */
function renderIndex(
  files: Link[],
  directories: Link[],
  isBundleRoot: boolean,
): string {
  const sections = [
    renderLinks("Files", files, true),
    renderLinks("Directories", directories, false),
  ]
    .filter(Boolean)
    .join("\n\n");
  const body = sections || "# Files";
  const version = isBundleRoot ? '---\nokf_version: "0.1"\n---\n\n' : "";
  return `${version}${body}\n`;
}

/** Renders a code-unit-sorted Markdown section. */
function renderLinks(
  heading: string,
  links: Link[],
  includeDescription: boolean,
): string {
  if (links.length === 0) return "";
  links.sort((left, right) => compareCodeUnits(left.href, right.href));
  const items = links.map(({ description, href, label }) => {
    const link = `- [${escapeLabel(normalizeInline(label))}](${href})`;
    return includeDescription && description
      ? `${link} - ${normalizeInline(description)}`
      : link;
  });
  return `# ${heading}\n\n${items.join("\n")}`;
}

/** Parses the optional title and description from YAML front matter. */
function parseFrontmatter(
  content: string,
  filePath: string,
): { description?: string; title?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
  if (!block) throw new Error(`${filePath} lacks YAML front matter.`);

  let fields: unknown;
  try {
    fields = parse(`\n${block}`, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    }) as unknown;
  } catch (error) {
    throw new Error(
      `${filePath} contains invalid YAML front matter: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error(`${filePath} YAML front matter must be a mapping.`);
  }

  const { description, title } = fields as Record<string, unknown>;
  if (
    description !== undefined &&
    (typeof description !== "string" || !description.trim())
  ) {
    throw new Error(`${filePath} YAML description must be a non-empty string.`);
  }
  if (title !== undefined && typeof title !== "string") {
    throw new Error(`${filePath} YAML title must be a string.`);
  }
  return {
    ...(description ? { description } : {}),
    ...(title ? { title } : {}),
  };
}

/** Reads a text file from the backend or throws an actionable error. */
async function readText(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<string> {
  try {
    const result = await backend.readRaw(filePath);
    if (result.error)
      throw new Error(`Unable to read ${filePath}: ${result.error}`);
    return fileDataToText(result.data?.content, filePath);
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function fileDataToText(
  content: string | string[] | Uint8Array | undefined,
  filePath: string,
): string {
  if (Array.isArray(content)) return content.join("\n");
  if (typeof content === "string") return content;
  throw new Error(`${filePath} is not a text file.`);
}

function entryName(entry: FileInfo): string {
  return path.posix.basename(entry.path.replace(/\/$/u, ""));
}

function normalizeInline(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
