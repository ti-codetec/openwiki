import { describe, expect, test } from "vitest";
import { createSystemPrompt } from "../src/agent/prompt.ts";

describe("OKF prompt guidance", () => {
  test("describes Google OKF required and recommended front matter accurately", () => {
    const prompt = createSystemPrompt("init", "repository");

    expect(prompt).toContain("Only `type` is required by OKF v0.1");
    expect(prompt).toContain(
      "`title`, `description`, `resource`, `tags`, and `timestamp` are recommended",
    );
    expect(prompt).toContain(
      "Preserve producer-defined front matter fields that you do not recognize",
    );
    expect(prompt).not.toContain(
      "do not add front matter fields outside the formatter above",
    );
  });

  test("does not require front matter on reserved OKF documents", () => {
    const prompt = createSystemPrompt("update", "repository");

    expect(prompt).toContain(
      "Every non-reserved concept Markdown file you create or update",
    );
    expect(prompt).toContain(
      "Reserved `index.md` and `log.md` files do not require concept front matter",
    );
    expect(prompt).toContain(
      "When creating or editing `log.md`, begin with `# Directory Update Log`, use `## YYYY-MM-DD` date groups in newest-first order, and include at least one list entry with non-empty textual content per date",
    );
  });

  test("states the runtime's fail-closed chat, timestamp, and migration behavior", () => {
    const prompt = createSystemPrompt("chat", "repository");

    expect(prompt).toContain("timezone is optional");
    expect(prompt).toContain("chat documentation mutations are validated");
    expect(prompt).toContain("fails closed");
    expect(prompt).toContain("root /openwiki/INSTRUCTIONS.md");
    expect(prompt).toContain("producer marker");
    expect(prompt).toContain("hidden directories");
  });
});
