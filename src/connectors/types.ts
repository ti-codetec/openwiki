import type { AuthProviderId } from "../auth/types.js";

export type ConnectorId =
  | "git-repo"
  | "google"
  | "hackernews"
  | "notion"
  | "slack"
  | "web-search"
  | "x";

/**
 * One secret the setup wizard collects for a source before it can connect, such
 * as an OAuth client id or an API key.
 */
export interface SourceSecretInput {
  /**
   * The managed env key the entered value is saved under.
   */
  envKey: string;

  /**
   * Field label shown in the prompt.
   */
  label: string;

  /**
   * When true, the field may be left blank. Absent means required.
   */
  optional?: boolean;

  /**
   * When true, the entered value is masked on screen and redacted in logs.
   * Absent means the value is not sensitive.
   */
  secret?: boolean;
}

/**
 * A source as presented in the onboarding wizard: how a connector is described,
 * what it needs to authenticate, and example ingestion goals.
 */
export interface SourceSetupOption {
  /**
   * The OAuth provider used to authenticate this source, when it uses one.
   * Absent for sources that need no OAuth (e.g. public feeds, local git).
   */
  authProvider?: AuthProviderId;

  /**
   * Human-readable source name shown in the menu.
   */
  displayName: string;

  /**
   * Example ingestion goals offered to the user as starting points.
   */
  examples: string[];

  /**
   * The connector this option configures.
   */
  id: ConnectorId;

  /**
   * Step-by-step setup guidance shown before credentials are collected.
   */
  instructions: string[];

  /**
   * Secrets the wizard must collect for this source; empty when none are
   * needed.
   */
  secretInputs: SourceSecretInput[];
}

export type ConnectorBackend =
  "direct-api" | "local-git" | "mcp-http" | "mcp-stdio";

export type ConnectorDefinition = {
  backend: ConnectorBackend;
  description: string;
  displayName: string;
  id: ConnectorId;
  requiredEnv: string[];
  supportsAgenticDiscovery: boolean;
};

export type ConnectorIngestOptions = {
  connectorConfig?: Record<string, unknown>;
  instanceId?: string;
  limit?: number;
  streams?: string[];
  windowHours?: number;
};

export type ConnectorIngestResult = {
  connectorId: ConnectorId;
  message: string;
  rawFiles: string[];
  runId: string;
  statePath: string;
  status: "error" | "skipped" | "success";
  warnings: string[];
};

export type ConnectorRuntime = ConnectorDefinition & {
  ingest: (options?: ConnectorIngestOptions) => Promise<ConnectorIngestResult>;
};

export type ConnectorState = {
  lastRunAt?: string;
  latestIds?: Record<string, string>;
  runs?: ConnectorRunSummary[];
  version: 1;
};

export type ConnectorRunSummary = {
  at: string;
  rawFiles: string[];
  runId: string;
  status: ConnectorIngestResult["status"];
  warnings: string[];
};

export type McpConnectorConfig = {
  allowedTools?: string[];
  enabled?: boolean;
  mode?: "mcp-http" | "mcp-stdio";
  transport?: {
    args?: string[];
    command?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    type: "http" | "stdio";
    url?: string;
  };
  readOnlyOperations?: McpReadOnlyOperation[];
};

export type McpReadOnlyOperation = {
  args?: Record<string, unknown>;
  name: string;
  type: "resource" | "tool";
};
