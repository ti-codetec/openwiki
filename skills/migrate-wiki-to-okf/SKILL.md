---
name: migrate-wiki-to-okf
description: Make an existing OpenWiki fully OKF-compliant. Use when any current wiki Markdown files lack valid OKF YAML front matter or when the user requests an OKF migration.
---

# Migrate Wiki to OKF

Add or correct OKF front matter across the existing wiki without changing accurate document bodies.

## Workflow

1. Before editing, recursively inventory every directory under the wiki root. Include the root and hidden directories, but treat `.git` as operational control data. Fail rather than following any symlink.
2. Write a plan listing every discovered directory and its assigned subagent.
3. Spawn exactly one subagent for each directory. If concurrency is limited, run them in batches; never combine multiple directories into one assignment.
4. Give each subagent write access only to Markdown files directly inside its assigned directory. It must not recurse into or modify another directory.
5. Wait for every subagent, then verify that every planned directory was processed. Send missed corrections back to a subagent scoped to that same directory.

## Subagent Task

Each subagent must:

- Inspect every non-generated Markdown file directly in its assigned directory.
- Leave already compliant files unchanged.
- Add or correct only the leading YAML front matter when needed. Preserve the existing Markdown body.
- Use a descriptive, self-explanatory `type`. Infer `title` and a one-line `description` (optimized for search and retrieval) from the document when useful. Add `resource` or `tags` only when supported by the document.
- Preserve all existing producer-defined fields. Add recommended OKF fields only when they are supported by the document, using this baseline formatter:

```yaml
---
type: <Type name>
title: <Optional display name>
description: <Optional one-line summary (optimized for search & retrieval)>
resource: <Optional canonical URI for the underlying asset>
tags: [<tag>, <tag>]
timestamp: <Optional ISO 8601 last-modified datetime>
# Other producer-defined fields are allowed
---
```

- ISO 8601 timestamps may be local datetimes without a timezone. Preserve a valid existing representation instead of forcing `Z`.
- Do not edit `index.md`; OpenWiki regenerates indexes deterministically outside hidden directories and never creates or rewrites an index inside a dot-directory. Do not treat `index.md` or `log.md` as concept documents or require concept front matter on them.
- If `log.md` exists, preserve its history while ensuring it contains only `# Directory Update Log`, valid `## YYYY-MM-DD` groups ordered newest first, and flat top-level list entries. Reject extra headings, nested lists, or structural content outside those groups; examples inside fences, indented code, and HTML comments do not count as groups or entries.
- In repository mode, leave root `/openwiki/INSTRUCTIONS.md` to final synchronization: it alone may be wrapped once with OpenWiki's producer-marked front matter while preserving every legacy body byte. Every unmarked file, including one beginning with parseable YAML, is legacy body. Nested and personal `INSTRUCTIONS.md` files are ordinary concepts and receive no special migration.
- Preserve every unknown front matter extension, including scalar, list, and mapping values.
- Report the files checked, the files changed, and any file whose metadata could not be inferred confidently.
- The description field here is important because retrieval tools use it. Keep it clear, single-line, and optimized for search.

Do not create, delete, move, or reorganize wiki pages during this migration.
