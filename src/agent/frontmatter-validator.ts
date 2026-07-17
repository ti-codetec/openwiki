import { ToolMessage } from "@langchain/core/messages";
import type { BackendProtocolV2 } from "deepagents";
import { marked } from "marked";
import path from "node:path";
import { parse } from "yaml";
import { MUTATION_PATH_METADATA_KEY } from "./docs-only-backend.js";
import type { OpenWikiOutputMode } from "./types.js";

const OKF_STRING_FIELDS = ["type", "title", "description", "resource"];
const INDEX_FILE = "index.md";
const LOG_FILE = "log.md";
const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

interface FrontmatterIssue {
  code: string;
  line?: number;
  message: string;
}

export type FrontmatterValidation =
  | {
      valid: true;
    }
  | {
      issues: FrontmatterIssue[];
      valid: false;
    };

/** Validates the OKF v0.1 minimum and known front-matter field types. */
export function validateOkfFrontmatter(content: string): FrontmatterValidation {
  const lines = content.split(/\r?\n/u);
  if (lines[0] !== "---") {
    return invalid(
      "missing_opening_delimiter",
      "File must begin with `---`.",
      1,
    );
  }

  const closingLine = lines.indexOf("---", 1);
  if (closingLine === -1) {
    return invalid(
      "missing_closing_delimiter",
      "Opening front matter has no closing `---` delimiter.",
    );
  }

  let fields: unknown;
  try {
    fields = parse(`\n${lines.slice(1, closingLine).join("\n")}`, {
      maxAliasCount: 100,
      schema: "core",
      uniqueKeys: true,
    }) as unknown;
  } catch (error) {
    return invalid("invalid_yaml", errorMessage(error));
  }
  if (!isRecord(fields)) {
    return invalid("invalid_yaml_root", "Front matter must be a YAML mapping.");
  }

  const issues: FrontmatterIssue[] = [];

  if (!Object.hasOwn(fields, "type")) {
    issues.push(issue("missing_type", "Required field `type` is missing."));
  }
  for (const field of OKF_STRING_FIELDS) {
    if (
      Object.hasOwn(fields, field) &&
      (typeof fields[field] !== "string" || !fields[field].trim())
    ) {
      issues.push(
        issue(
          `invalid_${field}`,
          `Field \`${field}\` must be a non-empty string.`,
        ),
      );
    }
  }
  if (Object.hasOwn(fields, "timestamp") && !isIsoTimestamp(fields.timestamp)) {
    issues.push(
      issue(
        "invalid_timestamp",
        "Field `timestamp` must be an ISO 8601 date-time.",
      ),
    );
  }
  if (
    Object.hasOwn(fields, "tags") &&
    (!Array.isArray(fields.tags) ||
      fields.tags.some((tag) => typeof tag !== "string" || !tag.trim()))
  ) {
    issues.push(
      issue(
        "invalid_tags",
        "Field `tags` must be a YAML list of non-empty strings.",
      ),
    );
  }

  return issues.length === 0 ? { valid: true } : { issues, valid: false };
}

/** Validates the reserved OKF directory update log structure. */
export function validateOkfLog(content: string): FrontmatterValidation {
  const lines = content.split(/\r?\n/u);
  if (lines[0] !== "# Directory Update Log") {
    return invalid(
      "missing_log_heading",
      "Log must begin with `# Directory Update Log`.",
      1,
    );
  }

  const issues: FrontmatterIssue[] = [];
  const groups: { date: string; hasEntry: boolean; line: number }[] = [];
  let currentGroup: (typeof groups)[number] | undefined;
  let line = 1;
  let firstStructuralToken = true;
  for (const token of marked.lexer(content)) {
    if (!isRecord(token) || typeof token.raw !== "string") continue;
    const tokenLine = line;
    line += token.raw.split("\n").length - 1;

    if (token.type === "space" || isHtmlCommentToken(token)) continue;
    if (firstStructuralToken) {
      firstStructuralToken = false;
      if (
        token.type === "heading" &&
        token.depth === 1 &&
        token.text === "Directory Update Log"
      ) {
        continue;
      }
    }

    if (token.type === "heading") {
      if (token.depth !== 2 || typeof token.text !== "string") {
        issues.push(
          issue(
            "unexpected_log_heading",
            "Only the initial title and level-two ISO date headings are allowed.",
            tokenLine,
          ),
        );
        currentGroup = undefined;
        continue;
      }

      const date = token.text.trim();
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !isCalendarDate(date)) {
        issues.push(
          issue(
            "invalid_log_date",
            "Level-two log headings must be valid ISO `YYYY-MM-DD` dates.",
            tokenLine,
          ),
        );
        currentGroup = undefined;
        continue;
      }
      currentGroup = { date, hasEntry: false, line: tokenLine };
      groups.push(currentGroup);
      continue;
    }

    if (token.type === "list") {
      if (!currentGroup) {
        issues.push(
          issue(
            "list_outside_log_date",
            "Every top-level log list must follow a date heading.",
            tokenLine,
          ),
        );
        continue;
      }
      currentGroup.hasEntry = true;
      if (containsEmptyListItem(token)) {
        issues.push(
          issue(
            "empty_log_entry",
            "Every top-level log list item must contain non-empty text.",
            tokenLine,
          ),
        );
      }
      if (containsNestedList(token)) {
        issues.push(
          issue(
            "nested_log_list",
            "Log entries must be a flat top-level list.",
            tokenLine,
          ),
        );
      }
      continue;
    }

    issues.push(
      issue(
        "unexpected_log_content",
        "Log structure may contain only date headings, flat lists, whitespace, and HTML comments.",
        tokenLine,
      ),
    );
  }

  if (
    groups.length === 0 &&
    !issues.some(({ code }) => code === "invalid_log_date")
  ) {
    issues.push(
      issue(
        "missing_log_date",
        "Log must contain at least one `## YYYY-MM-DD` date group.",
      ),
    );
  }

  for (const [index, group] of groups.entries()) {
    if (!group.hasEntry) {
      issues.push(
        issue(
          "missing_log_entry",
          `Date group \`${group.date}\` must contain at least one list entry.`,
          group.line,
        ),
      );
    }
    if (index > 0 && groups[index - 1].date <= group.date) {
      issues.push(
        issue(
          "log_dates_not_newest_first",
          "Log date groups must be unique and ordered newest first.",
          group.line,
        ),
      );
    }
  }

  return issues.length === 0 ? { valid: true } : { issues, valid: false };
}

/** Validates a preserved (non-generated) OKF index in a hidden directory. */
export function validateOkfIndex(content: string): FrontmatterValidation {
  const issues: FrontmatterIssue[] = [];
  let hasSection = false;
  let line = 1;
  for (const token of marked.lexer(content)) {
    if (!isRecord(token) || typeof token.raw !== "string") continue;
    const tokenLine = line;
    line += token.raw.split("\n").length - 1;
    if (token.type === "space" || isHtmlCommentToken(token)) continue;

    if (token.type === "heading") {
      if (
        token.depth !== 1 ||
        typeof token.text !== "string" ||
        !token.text.trim()
      ) {
        issues.push(
          issue(
            "invalid_index_heading",
            "Index sections must use non-empty level-one headings.",
            tokenLine,
          ),
        );
      } else {
        hasSection = true;
      }
      continue;
    }

    if (token.type === "list" && hasSection) {
      if (containsNestedList(token)) {
        issues.push(
          issue(
            "nested_index_list",
            "Index entries must be a flat top-level list.",
            tokenLine,
          ),
        );
      }
      continue;
    }

    issues.push(
      issue(
        "unexpected_index_content",
        "Index structure may contain only level-one sections and their flat lists.",
        tokenLine,
      ),
    );
  }
  if (!hasSection) {
    issues.push(
      issue(
        "missing_index_heading",
        "Index must contain at least one level-one section heading.",
      ),
    );
  }
  return issues.length === 0 ? { valid: true } : { issues, valid: false };
}

/** Appends an actionable warning when a wiki write leaves invalid OKF content. */
export async function addFrontmatterWarning<Result>(
  result: Result,
  backend: BackendProtocolV2,
  outputMode: OpenWikiOutputMode,
  toolName: string,
): Promise<Result> {
  if (!WRITE_TOOLS.has(toolName)) return result;

  const mutation = getToolMessages(result)
    .map((message) => ({
      message,
      path: message.metadata?.[MUTATION_PATH_METADATA_KEY],
    }))
    .find(
      (item): item is { message: ToolMessage; path: string } =>
        typeof item.path === "string" &&
        isWikiMarkdownPath(item.path, outputMode),
    );
  if (!mutation) return result;

  const validation = await validatePersistedFile(backend, mutation.path);
  if (validation.valid) return result;

  const warning = formatWarning(mutation.path, validation.issues);
  mutation.message.content =
    typeof mutation.message.content === "string"
      ? `${mutation.message.content}\n\n${warning}`
      : [...mutation.message.content, { text: warning, type: "text" }];
  return result;
}

/** Reads a persisted Markdown file and validates its final OKF structure. */
async function validatePersistedFile(
  backend: BackendProtocolV2,
  filePath: string,
): Promise<FrontmatterValidation> {
  const read = await backend.readRaw(filePath);
  const content = read.data?.content;
  if (read.error || content === undefined || content instanceof Uint8Array) {
    return invalid(
      "file_read_failed",
      `Could not read the final Markdown text: ${read.error ?? "no text data"}.`,
    );
  }
  const text = Array.isArray(content) ? content.join("\n") : content;
  return path.posix.basename(filePath) === LOG_FILE
    ? validateOkfLog(text)
    : validateOkfFrontmatter(text);
}

/** Extracts tool messages from direct and Command-like tool results. */
function getToolMessages(result: unknown): ToolMessage[] {
  if (ToolMessage.isInstance(result)) return [result];
  if (!isRecord(result)) return [];

  const messages = isRecord(result.update) ? result.update.messages : undefined;
  return Array.isArray(messages)
    ? messages.filter((message): message is ToolMessage =>
        ToolMessage.isInstance(message),
      )
    : [];
}

/** Checks whether a path targets a Markdown file inside the configured wiki. */
function isWikiMarkdownPath(
  filePath: string,
  outputMode: OpenWikiOutputMode,
): boolean {
  const normalized = path.posix.normalize(
    `/${filePath.trim().replaceAll("\\", "/").replace(/^\/+/, "")}`,
  );
  return (
    path.posix.extname(normalized).toLowerCase() === ".md" &&
    path.posix.basename(normalized) !== INDEX_FILE &&
    (outputMode === "local-wiki" || normalized.startsWith("/openwiki/"))
  );
}

/** Formats validation issues as an instruction for the agent to correct the file. */
function formatWarning(path: string, issues: FrontmatterIssue[]): string {
  const details = issues
    .map(
      ({ code, line, message }) =>
        `- [${code}]${line ? ` line ${line}:` : ""} ${message}`,
    )
    .join("\n");
  return `WARNING: OKF validation failed in \`${path}\`.\n${details}\nYou MUST correct this file before continuing.`;
}

/** Checks whether an ISO date string names a real calendar day. */
function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/** Checks supported ISO 8601 extended/basic date-times, with optional zone. */
function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const extended =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2})(?::(\d{2})([.,]\d+)?)?(.*)$/u.exec(
      value,
    );
  const basic =
    /^(\d{4})(\d{2})(\d{2})[Tt](\d{2})(\d{2})(?:(\d{2})([.,]\d+)?)?(.*)$/u.exec(
      value,
    );
  const match = extended ?? basic;
  if (!match) return false;
  const [, year, month, day, hourText, minuteText, secondText, fraction, zone] =
    match;
  if (
    !year ||
    !month ||
    !day ||
    !hourText ||
    !minuteText ||
    zone === undefined
  ) {
    return false;
  }
  if (!isCalendarDate(`${year}-${month}-${day}`)) return false;

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  if (minute > 59 || second > 60) return false;
  const fractionIsZero = fraction === undefined || /^[.,]0+$/u.test(fraction);
  if (
    hour > 24 ||
    (hour === 24 && (minute !== 0 || second !== 0 || !fractionIsZero))
  ) {
    return false;
  }
  return isIsoZone(zone);
}

function isIsoZone(value: string): boolean {
  if (value === "" || value === "Z" || value === "z") return true;
  const match = /^([+-])(\d{2})(?::?(\d{2}))?$/u.exec(value);
  if (!match?.[2]) return false;
  return Number(match[2]) <= 23 && Number(match[3] ?? "0") <= 59;
}

function isHtmlCommentToken(token: Record<string, unknown>): boolean {
  return (
    token.type === "html" &&
    typeof token.raw === "string" &&
    /^\s*<!--[\s\S]*-->\s*$/u.test(token.raw)
  );
}

function containsNestedList(token: Record<string, unknown>): boolean {
  const items = Array.isArray(token.items) ? token.items : [];
  return items.some((item) => containsTokenType(item, "list"));
}

function containsEmptyListItem(token: Record<string, unknown>): boolean {
  const items = Array.isArray(token.items) ? token.items : [];
  return items.some((item) => !hasRenderedText(item));
}

function hasRenderedText(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRenderedText);
  if (!isRecord(value)) return false;

  if (
    value.type === "codespan" ||
    value.type === "code" ||
    value.type === "escape"
  ) {
    return typeof value.text === "string" && Boolean(value.text.trim());
  }
  if (
    value.type === "list_item" ||
    value.type === "text" ||
    value.type === "paragraph" ||
    value.type === "strong" ||
    value.type === "em" ||
    value.type === "del" ||
    value.type === "link"
  ) {
    if (Array.isArray(value.tokens)) return value.tokens.some(hasRenderedText);
    return (
      value.type === "text" &&
      typeof value.text === "string" &&
      Boolean(value.text.trim())
    );
  }
  return false;
}

function containsTokenType(value: unknown, type: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsTokenType(item, type));
  }
  if (!isRecord(value)) return false;
  if (value.type === type) return true;
  return Object.entries(value).some(
    ([key, child]) =>
      key !== "raw" && key !== "text" && containsTokenType(child, type),
  );
}

/** Creates a failed validation result containing one issue. */
function invalid(
  code: string,
  message: string,
  line?: number,
): FrontmatterValidation {
  return { issues: [issue(code, message, line)], valid: false };
}

/** Creates a structured front-matter validation issue. */
function issue(code: string, message: string, line?: number): FrontmatterIssue {
  return { code, ...(line ? { line } : {}), message };
}

/** Narrows an unknown value to a non-array object record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Converts an unknown thrown value into a readable message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
