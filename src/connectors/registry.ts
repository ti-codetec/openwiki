import { createGitRepoConnector } from "./sources/git-repo.js";
import { createMcpConnector } from "./sources/mcp.js";
import { createSlackConnector } from "./sources/slack.js";
import { createXConnector } from "./sources/x.js";
import type { ConnectorId, ConnectorRuntime } from "./types.js";

export const CONNECTOR_IDS = [
  "git-repo",
  "notion",
  "x",
  "google",
  "slack",
] as const satisfies readonly ConnectorId[];

export function createConnectorRegistry(): Record<
  ConnectorId,
  ConnectorRuntime
> {
  return {
    "git-repo": createGitRepoConnector(),
    google: createMcpConnector({
      description:
        "Google connector focused on Gmail ingestion first, with room to add Drive, Calendar, and other Google providers later.",
      displayName: "Google / Gmail",
      id: "google",
      requiredEnv: [
        "OPENWIKI_GMAIL_ACCESS_TOKEN",
        "OPENWIKI_GMAIL_REFRESH_TOKEN",
      ],
    }),
    notion: createMcpConnector({
      description:
        "Notion connector backed by the hosted Notion MCP server or another configured read-only MCP server.",
      displayName: "Notion",
      id: "notion",
      requiredEnv: ["OPENWIKI_NOTION_MCP_ACCESS_TOKEN"],
    }),
    slack: createSlackConnector(),
    x: createXConnector(),
  };
}

export function isConnectorId(value: string): value is ConnectorId {
  return (CONNECTOR_IDS as readonly string[]).includes(value);
}
