import { ToolMessage } from "@langchain/core/messages";
import type { BackendProtocolV2 } from "deepagents";
import { describe, expect, test, vi } from "vitest";
import { MUTATION_PATH_METADATA_KEY } from "../src/agent/docs-only-backend.ts";
import {
  addFrontmatterWarning,
  validateOkfFrontmatter,
  validateOkfLog,
} from "../src/agent/frontmatter-validator.ts";

function markdown(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\n# Page\n`;
}

function backendWith(content: string) {
  return {
    readRaw: vi.fn(() => ({
      data: {
        content,
        created_at: "2026-07-13T00:00:00.000Z",
        mimeType: "text/markdown",
        modified_at: "2026-07-13T00:00:00.000Z",
      },
    })),
  } satisfies Pick<BackendProtocolV2, "readRaw">;
}

function mutationMessage(path = "/openwiki/page.md") {
  return new ToolMessage({
    content: "Successfully wrote file.",
    metadata: { [MUTATION_PATH_METADATA_KEY]: path },
    tool_call_id: "write-1",
  });
}

describe("validateOkfFrontmatter", () => {
  test("accepts the required type, recommended fields, and producer extensions", () => {
    expect(validateOkfFrontmatter(markdown("type: Reference"))).toEqual({
      valid: true,
    });
    expect(
      validateOkfFrontmatter(
        markdown(
          [
            "type: API Endpoint",
            'title: "Create order"',
            "description: >-",
            "  Creates a completed",
            "  order.",
            "resource: https://example.com/orders",
            "tags:",
            "  - api",
            "  - orders",
            'timestamp: "2026-07-13T12:30:00Z"',
            "author: documentation-agent",
            "confidence: 0.95",
            "status: verified",
          ].join("\n"),
        ),
      ),
    ).toEqual({ valid: true });
  });

  test("reports deterministic delimiter and required-field issues", () => {
    expect(validateOkfFrontmatter("# Page")).toEqual({
      issues: [
        {
          code: "missing_opening_delimiter",
          line: 1,
          message: "File must begin with `---`.",
        },
      ],
      valid: false,
    });
    expect(validateOkfFrontmatter("---\ntype: Reference")).toMatchObject({
      issues: [{ code: "missing_closing_delimiter" }],
      valid: false,
    });
    expect(validateOkfFrontmatter(markdown("title: Page"))).toMatchObject({
      issues: [{ code: "missing_type" }],
      valid: false,
    });
  });

  test("reports malformed and duplicate YAML", () => {
    for (const frontmatter of [
      "type: [unterminated",
      "type: Reference\ntype: Playbook",
    ]) {
      expect(validateOkfFrontmatter(markdown(frontmatter))).toMatchObject({
        issues: [{ code: "invalid_yaml" }],
        valid: false,
      });
    }
    const malformed = validateOkfFrontmatter(
      markdown("type: Reference\ndescription: [unterminated"),
    );
    if (malformed.valid) throw new Error("Expected invalid YAML.");
    expect(malformed.issues[0].message).toContain("line 3");
  });

  test("reports mistyped standard fields without rejecting extensions", () => {
    const result = validateOkfFrontmatter(
      markdown(
        [
          "type: Reference",
          'timestamp: "2026-07-13T00:00:00Z"',
          "producer_metadata:",
          "  owner: platform-team",
          "title: [Not a string]",
          "description: 123",
          "tags: docs, api",
        ].join("\n"),
      ),
    );

    expect(result).toMatchObject({
      issues: [
        { code: "invalid_title" },
        { code: "invalid_description" },
        { code: "invalid_tags" },
      ],
      valid: false,
    });
  });

  test.each([
    "not-a-timestamp",
    "2026-02-30T00:00:00Z",
    "2026-07-13",
    "2026-07-13T25:00:00Z",
  ])("rejects a non-ISO timestamp: %s", (timestamp) => {
    expect(
      validateOkfFrontmatter(
        markdown(`type: Reference\ntimestamp: ${JSON.stringify(timestamp)}`),
      ),
    ).toMatchObject({
      issues: [{ code: "invalid_timestamp" }],
      valid: false,
    });
  });

  test.each([
    "0000-01-01T00:00:00",
    "0099-12-31T23:59",
    "2026-07-13t12:30:00z",
    "20260713T123000Z",
    "2026-07-13T12:30:00+0130",
    "2026-07-13T12:30:00+01",
    "2026-07-13T12:30:00,125-01:30",
    "2026-12-31T24:00:00Z",
    "2026-12-31T23:59:60Z",
  ])(
    "accepts an ISO 8601 datetime allowed by the OKF field: %s",
    (timestamp) => {
      expect(
        validateOkfFrontmatter(
          markdown(`type: Reference\ntimestamp: ${JSON.stringify(timestamp)}`),
        ),
      ).toEqual({ valid: true });
    },
  );

  test.each([
    "0099-02-29T00:00:00",
    "2026-13-01T00:00:00Z",
    "2026-07-13T24:00:01Z",
    "2026-07-13T12:30:61Z",
  ])("rejects a semantically impossible ISO timestamp: %s", (timestamp) => {
    expect(
      validateOkfFrontmatter(
        markdown(`type: Reference\ntimestamp: ${JSON.stringify(timestamp)}`),
      ),
    ).toMatchObject({
      issues: [{ code: "invalid_timestamp" }],
      valid: false,
    });
  });
});

describe("validateOkfLog", () => {
  test("accepts date-grouped entries in newest-first order", () => {
    expect(
      validateOkfLog(
        "# Directory Update Log\n\n## 2026-07-16\n\n- **Update**: Latest.\n\n## 2026-07-15\n\n* **Creation**: Earlier.\n\n## 2026-07-14\n\n+ **Correction**: Older.\n\n## 2026-07-13\n\n1. **Review**: Oldest.\n",
      ),
    ).toEqual({ valid: true });
  });

  test.each(["-", "*", "+", "1."])(
    "rejects an empty top-level log item using %s",
    (marker) => {
      const result = validateOkfLog(
        `# Directory Update Log\n\n## 2026-07-16\n\n${marker}\n`,
      );
      if (result.valid)
        throw new Error("Expected an empty entry to be invalid.");
      expect(result.issues.map((item) => item.code)).toContain(
        "empty_log_entry",
      );
    },
  );

  test.each([
    "- <!-- comentário -->",
    "* [](https://example.test)",
    "+ ** **",
    "1. <!-- comentário -->",
    "1. [](https://example.test)",
    "1. ** **",
  ])("rejects a top-level log item without rendered prose: %s", (entry) => {
    const result = validateOkfLog(
      `# Directory Update Log\n\n## 2026-07-16\n\n${entry}\n`,
    );
    if (result.valid)
      throw new Error(
        "Expected an entry without rendered prose to be invalid.",
      );
    expect(result.issues.map((item) => item.code)).toContain("empty_log_entry");
  });

  test.each([
    "- **Formatted prose**",
    "* [Labeled link](https://example.test)",
    "+ `usefulCode()`",
    "1. _Ordered prose_",
  ])("accepts rendered prose in a top-level log item: %s", (entry) => {
    expect(
      validateOkfLog(`# Directory Update Log\n\n## 2026-07-16\n\n${entry}\n`),
    ).toEqual({ valid: true });
  });

  test.each([
    ["# Wrong heading\n", "missing_log_heading"],
    ["# Directory Update Log\n", "missing_log_date"],
    [
      "# Directory Update Log\n\n## 2026-02-30\n\n- Invalid date.\n",
      "invalid_log_date",
    ],
    [
      "# Directory Update Log\n\n## 2026-07-15\n\n- Earlier.\n\n## 2026-07-16\n\n- Later.\n",
      "log_dates_not_newest_first",
    ],
    [
      "# Directory Update Log\n\n## 2026-07-16\n\nNo list entry.\n",
      "missing_log_entry",
    ],
    [
      "# Directory Update Log\n\n```md\n## 2026-07-16\n\n- Example, not an entry.\n```\n",
      "missing_log_date",
    ],
    [
      "# Directory Update Log\n\n## 2026-07-16\n\n~~~md\n+ Example, not an entry.\n~~~\n",
      "missing_log_entry",
    ],
    [
      "# Directory Update Log\n\n## 2026-07-16\n\n    - Indented code, not an entry.\n",
      "missing_log_entry",
    ],
    [
      "# Directory Update Log\n\n<!--\n## 2026-07-16\n\n- Commented example.\n-->\n",
      "missing_log_date",
    ],
    [
      "# Directory Update Log\n\n## 2026-07-16\n\n<!--\n* Commented example.\n-->\n",
      "missing_log_entry",
    ],
    [
      "# Directory Update Log\n\n<pre>\n## 2026-07-16\n- Raw HTML example.\n</pre>\n",
      "missing_log_date",
    ],
  ])("rejects malformed reserved logs with %s", (content, code) => {
    const result = validateOkfLog(content);
    if (result.valid) throw new Error("Expected invalid log structure.");
    expect(result.issues.map((item) => item.code)).toContain(code);
  });

  test("accepts early proleptic-Gregorian dates and comments without counting comments as entries", () => {
    expect(
      validateOkfLog(
        "# Directory Update Log\n\n<!-- producer note -->\n\n## 0099-01-01\n\n- Early valid date.\n\n## 0000-01-01\n\n* Earliest four-digit year.\n",
      ),
    ).toEqual({ valid: true });
  });

  test.each([
    [
      "# Directory Update Log\n\n# Extra heading\n\n## 2026-07-16\n\n- Entry.\n",
      "unexpected_log_heading",
    ],
    [
      "# Directory Update Log\n\n## 2026-07-16\n\n### Extra heading\n\n- Entry.\n",
      "unexpected_log_heading",
    ],
    [
      "# Directory Update Log\n\nParagraph outside a date group.\n\n## 2026-07-16\n\n- Entry.\n",
      "unexpected_log_content",
    ],
    [
      "# Directory Update Log\n\n- Entry before date.\n\n## 2026-07-16\n\n- Entry.\n",
      "list_outside_log_date",
    ],
    [
      "# Directory Update Log\n\n## 2026-07-16\n\n- Parent.\n  - Nested child.\n",
      "nested_log_list",
    ],
    [
      "# Directory Update Log\n\n## 2026-07-16\n\n> - Quoted entry.\n",
      "unexpected_log_content",
    ],
    [
      "# Directory Update Log\n\n## 2026-07-16\n\n```md\n- Example only.\n```\n",
      "missing_log_entry",
    ],
  ])("rejects non-flat or out-of-format log structure", (content, code) => {
    const result = validateOkfLog(content);
    if (result.valid) throw new Error("Expected invalid log structure.");
    expect(result.issues.map((item) => item.code)).toContain(code);
  });
});

describe("addFrontmatterWarning", () => {
  test("appends actionable validation details after an invalid wiki write", async () => {
    const message = mutationMessage();
    await addFrontmatterWarning(
      message,
      backendWith("# Missing front matter"),
      "repository",
      "write_file",
    );

    expect(message.content).toContain("OKF validation failed");
    expect(message.content).toContain("[missing_opening_delimiter] line 1");
    expect(message.content).toContain("MUST correct this file");
  });

  test("leaves valid files and unrelated tool calls unchanged", async () => {
    const validMessage = mutationMessage();
    const validBackend = backendWith(markdown("type: Reference"));
    await addFrontmatterWarning(
      validMessage,
      validBackend,
      "repository",
      "edit_file",
    );
    expect(validMessage.content).toBe("Successfully wrote file.");

    const outsideMessage = mutationMessage("/README.md");
    const outsideBackend = backendWith("invalid");
    await addFrontmatterWarning(
      outsideMessage,
      outsideBackend,
      "repository",
      "write_file",
    );
    expect(outsideBackend.readRaw).not.toHaveBeenCalled();

    await addFrontmatterWarning(
      mutationMessage(),
      outsideBackend,
      "repository",
      "read_file",
    );
    expect(outsideBackend.readRaw).not.toHaveBeenCalled();
  });

  test("does not validate generated index front matter", async () => {
    const message = mutationMessage("/openwiki/index.md");
    const backend = backendWith("# Files\n");

    await addFrontmatterWarning(message, backend, "repository", "write_file");

    expect(message.content).toBe("Successfully wrote file.");
    expect(backend.readRaw).not.toHaveBeenCalled();
  });

  test("validates reserved log structure without requiring front matter", async () => {
    const validMessage = mutationMessage("/openwiki/operations/log.md");
    const validBackend = backendWith(
      "# Directory Update Log\n\n## 2026-07-16\n\n- **Update**: Refreshed docs.\n",
    );
    await addFrontmatterWarning(
      validMessage,
      validBackend,
      "repository",
      "write_file",
    );
    expect(validMessage.content).toBe("Successfully wrote file.");

    const invalidMessage = mutationMessage("/openwiki/log.md");
    await addFrontmatterWarning(
      invalidMessage,
      backendWith("# Reserved OKF document\n"),
      "repository",
      "write_file",
    );
    expect(invalidMessage.content).toContain("[missing_log_heading]");
  });

  test("treats differently-cased Markdown names as concepts", async () => {
    const message = mutationMessage("/openwiki/INDEX.md");
    const backend = backendWith("# Not the reserved lowercase filename\n");

    await addFrontmatterWarning(message, backend, "repository", "write_file");

    expect(message.content).toContain("[missing_opening_delimiter]");
    expect(backend.readRaw).toHaveBeenCalled();
  });

  test("edits tool messages nested in Command results", async () => {
    const message = mutationMessage();
    const command = { update: { messages: [message] } };
    await addFrontmatterWarning(
      command,
      backendWith(markdown("title: Missing type")),
      "repository",
      "edit_file",
    );

    expect(message.content).toContain("[missing_type]");
  });
});
