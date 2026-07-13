import { isDevelopmentMode } from "./parse.js";

/**
 * A single label/description row in a help section.
 */
export interface HelpRow {
  /**
   * The left-column label (a command, subcommand, or option name).
   */
  label: string;

  /**
   * The right-column explanation of what it does.
   */
  description: string;
}

/**
 * The structured content of the `--help` screen.
 */
export interface HelpContent {
  /**
   * The product name shown in the help header.
   */
  title: string;

  /**
   * One-line summary of what OpenWiki does.
   */
  description: string;

  /**
   * Invocation syntax forms, one per line.
   */
  usage: string[];

  /**
   * The subcommands and run modes, as label/description rows.
   */
  commands: HelpRow[];

  /**
   * The available flags, as label/description rows.
   */
  options: HelpRow[];

  /**
   * Extra options shown only in development mode.
   */
  developmentOptions: HelpRow[];

  /**
   * Example invocations.
   */
  examples: string[];

  /**
   * Extra examples shown only in development mode.
   */
  developmentExamples: string[];
}

/**
 * The content rendered on the `--help` screen (by the UI and {@link getHelpText}).
 */
export const helpContent: HelpContent = {
  title: "OpenWiki",
  description:
    "Run an agent that generates and maintains a project or local knowledge wiki.",
  usage: [
    "openwiki code [--init|--update] [message]",
    "openwiki personal [--init|--update] [message]",
    "openwiki --mode <personal|code> [--init|--update] [message]",
    "openwiki [--modelId <model>]",
    "openwiki [--modelId <model>] [message]",
    "openwiki --update [message]",
    "openwiki auth <provider>",
    "openwiki auth configure <provider> [--force]",
    "openwiki auth tools <provider>",
    "openwiki ingest <source|source-instance|all>",
    "openwiki cron list",
    "openwiki cron pause <source|all>",
    "openwiki cron resume <source|all>",
    "openwiki cron delete <source|all>",
    "openwiki ngrok start [url] [--port <port>]",
  ],
  commands: [
    {
      label: "openwiki code",
      description:
        "Run OpenWiki for the current repository, writing docs under repo openwiki/ and using GitHub Actions for recurrence.",
    },
    {
      label: "openwiki personal",
      description:
        "Run OpenWiki as your local personal brain over configured sources, writing to ~/.openwiki/wiki.",
    },
    {
      label: "openwiki",
      description: "Open the interactive OpenWiki personal brain chat.",
    },
    {
      label: "openwiki auth <provider>",
      description:
        "Authenticate, create connector config, and discover MCP tools when available.",
    },
    {
      label: "openwiki auth configure <provider>",
      description:
        "Create local connector config that references saved auth env vars.",
    },
    {
      label: "openwiki auth tools <provider>",
      description: "List available MCP tools for a configured auth provider.",
    },
    {
      label: "openwiki ingest <source|source-instance|all>",
      description:
        "Run ingestion and wiki update runs for one connector, one source instance, or all configured sources.",
    },
    {
      label: "openwiki cron list",
      description: "List saved connector schedules and local launchd status.",
    },
    {
      label: "openwiki cron pause <source|all>",
      description:
        "Pause saved connector schedules and reconcile the Mac wake window.",
    },
    {
      label: "openwiki cron resume <source|all>",
      description:
        "Resume paused connector schedules and reconcile the Mac wake window.",
    },
    {
      label: "openwiki cron delete <source|all>",
      description:
        "Delete saved connector schedules and remove stale local schedule files.",
    },
    {
      label: "openwiki ngrok start [url]",
      description:
        "Start an ngrok tunnel for Slack OAuth, optionally using a fixed HTTPS URL.",
    },
  ],
  options: [
    {
      label: "--init",
      description:
        "Generate initial OpenWiki documentation for a selected mode. Use openwiki personal --init or openwiki code --init.",
    },
    {
      label: "--update",
      description:
        "Update existing OpenWiki documentation and ingest configured connectors when relevant.",
    },
    {
      label: "--mode <personal|code>",
      description:
        "Choose the personal brain (local, over configured sources) or the code brain (repository docs).",
    },
    {
      label: "-p, --print",
      description: "Run once and print the final assistant output.",
    },
    {
      label: "--modelId <id>",
      description: "Use a model ID for this run.",
    },
  ],
  developmentOptions: [
    {
      label: "--dry-run",
      description: "Show what would run without invoking the agent.",
    },
  ],
  examples: [
    "openwiki",
    "openwiki personal --init",
    "openwiki code --init",
    "openwiki --update",
    "openwiki --update --mode personal",
    'openwiki "What can you do?"',
    'openwiki -p "Summarize what OpenWiki can do"',
    "openwiki --modelId gpt-5.5",
    'openwiki --update --modelId gpt-5.5 "Please document the API routes first"',
    'openwiki --update "Refresh the wiki from configured connectors"',
    "openwiki ingest all",
    "openwiki ingest web-search",
    "openwiki ingest web-search-2",
    "openwiki cron list",
    "openwiki cron pause web-search",
    "openwiki cron resume web-search",
    "openwiki cron delete web-search",
    "openwiki auth slack",
    "openwiki auth gmail",
    "openwiki auth notion",
    "openwiki auth tools notion",
    "openwiki ngrok start",
    "openwiki ngrok start https://openwiki.ngrok.app",
  ],
  developmentExamples: ["openwiki --dry-run"],
};

/**
 * Renders {@link helpContent} as the plain-text `--help` output.
 */
export function getHelpText(): string {
  const helpSections = [
    helpContent.title,
    `  ${helpContent.description}`,
    "",
    "Usage",
    ...helpContent.usage.map((line) => `  ${line}`),
    "",
    "Commands",
    ...formatRows(helpContent.commands),
    "",
    "Options",
    ...formatRows(helpContent.options),
    "",
  ];

  if (isDevelopmentMode()) {
    helpSections.push(
      "Development Options",
      ...formatRows(helpContent.developmentOptions),
      "",
    );
  }

  helpSections.push(
    "Examples",
    ...helpContent.examples.map((line) => `  ${line}`),
  );

  if (isDevelopmentMode()) {
    helpSections.push(
      ...helpContent.developmentExamples.map((line) => `  ${line}`),
    );
  }

  return helpSections.join("\n");
}

function formatRows(rows: HelpRow[]): string[] {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));

  return rows.map(
    (row) => `  ${row.label.padEnd(labelWidth)}  ${row.description}`,
  );
}
