import {
  createConnectorRegistry,
  isConnectorId,
} from "./connectors/registry.js";
import type {
  ConnectorId,
  ConnectorIngestResult,
  ConnectorRuntime,
} from "./connectors/types.js";
import { loadOpenWikiEnv } from "./env.js";
import {
  readOpenWikiOnboardingConfig,
  type OnboardingSourceConfig,
  type OpenWikiOnboardingConfig,
} from "./onboarding.js";
import { getConnectorConfigPath } from "./openwiki-home.js";
import { createOpenWikiThreadId, runOpenWikiAgent } from "./agent/index.js";
import type {
  OpenWikiRunEvent,
  OpenWikiRunOptions,
  OpenWikiRunResult,
} from "./agent/types.js";

const INGESTION_WINDOW_HOURS = 24;

export type IngestionTarget = ConnectorId | "all";

export type SourceIngestionResult = {
  agentResult?: OpenWikiRunResult;
  connectorId: ConnectorId;
  deterministicPull?: ConnectorIngestResult;
  displayName: string;
  rawFiles: string[];
  status: "agent-updated" | "error" | "skipped";
};

export type OpenWikiIngestionResult = {
  results: SourceIngestionResult[];
};

export type OpenWikiIngestionOptions = Pick<
  OpenWikiRunOptions,
  "debug" | "modelId" | "onEvent"
> & {
  target: IngestionTarget;
};

export async function runOpenWikiIngestion(
  cwd = process.cwd(),
  options: OpenWikiIngestionOptions,
): Promise<OpenWikiIngestionResult> {
  await loadOpenWikiEnv();
  const config = await readOpenWikiOnboardingConfig();
  const registry = createConnectorRegistry();
  const connectorIds = resolveIngestionConnectorIds(options.target, config);
  const results: SourceIngestionResult[] = [];

  for (const connectorId of connectorIds) {
    const connector = registry[connectorId];
    const sourceConfig = config.sources[connectorId];

    if (!sourceConfig) {
      results.push({
        connectorId,
        displayName: connector.displayName,
        rawFiles: [],
        status: "skipped",
      });
      continue;
    }

    results.push(
      await runSourceIngestion({
        config,
        connector,
        cwd,
        emit: options.onEvent,
        modelId: options.modelId,
        sourceConfig,
      }),
    );
  }

  return { results };
}

export function parseIngestionTarget(value: string): IngestionTarget | null {
  if (value === "all") {
    return "all";
  }

  return isConnectorId(value) ? value : null;
}

async function runSourceIngestion({
  config,
  connector,
  cwd,
  emit,
  modelId,
  sourceConfig,
}: {
  config: OpenWikiOnboardingConfig;
  connector: ConnectorRuntime;
  cwd: string;
  emit?: (event: OpenWikiRunEvent) => void;
  modelId?: string | null;
  sourceConfig: OnboardingSourceConfig;
}): Promise<SourceIngestionResult> {
  emitText(emit, `\nStarting ${connector.displayName} ingestion.\n`);

  try {
    const deterministicPull = isDeterministicConnector(connector)
      ? await connector.ingest({ windowHours: INGESTION_WINDOW_HOURS })
      : undefined;
    const rawFiles = deterministicPull?.rawFiles ?? [];

    if (
      deterministicPull &&
      deterministicPull.status === "error" &&
      rawFiles.length === 0
    ) {
      emitText(
        emit,
        `${connector.displayName} deterministic pull failed: ${deterministicPull.message}\n`,
      );
      return {
        connectorId: connector.id,
        deterministicPull,
        displayName: connector.displayName,
        rawFiles,
        status: "error",
      };
    }

    emitDeterministicPullSummary(emit, deterministicPull);

    const agentResult = await runOpenWikiAgent("update", cwd, {
      isFollowup: false,
      modelId,
      onEvent: emit,
      threadId: createOpenWikiThreadId(cwd),
      userMessage: createSourceUpdateMessage({
        config,
        connector,
        deterministicPull,
        rawFiles,
        sourceConfig,
      }),
    });

    return {
      agentResult,
      connectorId: connector.id,
      deterministicPull,
      displayName: connector.displayName,
      rawFiles,
      status: "agent-updated",
    };
  } catch (error) {
    const message = getErrorMessage(error);
    emitText(emit, `${connector.displayName} ingestion failed: ${message}\n`);
    return {
      connectorId: connector.id,
      displayName: connector.displayName,
      rawFiles: [],
      status: "error",
    };
  }
}

function resolveIngestionConnectorIds(
  target: IngestionTarget,
  config: OpenWikiOnboardingConfig,
): ConnectorId[] {
  if (target !== "all") {
    return [target];
  }

  return Object.entries(config.sources)
    .filter(([, sourceConfig]) => Boolean(sourceConfig?.connectedAt))
    .map(([connectorId]) => connectorId)
    .filter(isConnectorId);
}

function isDeterministicConnector(connector: ConnectorRuntime): boolean {
  return !connector.supportsAgenticDiscovery;
}

function createSourceUpdateMessage({
  config,
  connector,
  deterministicPull,
  rawFiles,
  sourceConfig,
}: {
  config: OpenWikiOnboardingConfig;
  connector: ConnectorRuntime;
  deterministicPull: ConnectorIngestResult | undefined;
  rawFiles: string[];
  sourceConfig: OnboardingSourceConfig;
}): string {
  const ingestionGoal = sourceConfig.ingestionGoal?.trim();
  const wikiGoal = config.wikiGoal?.trim();

  if (deterministicPull) {
    return `
Run an OpenWiki source update for ${connector.displayName} (${connector.id}).

Scope:
- This is one source-specific ingestion run.
- Use the last ${INGESTION_WINDOW_HOURS} hours of newly pulled data for this source.
- Update the wiki only with information relevant to this source and the user's goals.

User wiki goal:
${wikiGoal || "(not provided)"}

Source-specific instructions:
${ingestionGoal || "(not provided)"}

Deterministic pull result:
- Status: ${deterministicPull.status}
- Message: ${deterministicPull.message}
- Raw data files:
${formatRawFileList(rawFiles)}

Instructions:
- Read the raw data files above before updating the wiki.
- These paths are host filesystem paths under ~/.openwiki. Do not pass them to virtual filesystem tools. Use shell commands such as cat, jq, or node from the repository root if you need to inspect them.
- Summarize, merge, and deduplicate the new source data into the OpenWiki docs under /openwiki.
- Do not run other source ingestions in this run.
`.trim();
  }

  return `
Run an OpenWiki source update for ${connector.displayName} (${connector.id}).

Scope:
- This is one source-specific ingestion run.
- Ingest relevant information from this provider over the last ${INGESTION_WINDOW_HOURS} hours.
- This source cannot be fully pulled deterministically before the agent run, so use available OpenWiki connector tools, MCP tools, local repository inspection, and source config as needed.

User wiki goal:
${wikiGoal || "(not provided)"}

Source-specific instructions:
${ingestionGoal || "(not provided)"}

Source config:
- Connector config path: ${getConnectorConfigPath(connector.id)}

Instructions:
- Gather only data relevant to this source and the last ${INGESTION_WINDOW_HOURS} hours.
- Update the OpenWiki docs under /openwiki with the relevant findings.
- Do not run other source ingestions in this run.
`.trim();
}

function emitDeterministicPullSummary(
  emit: ((event: OpenWikiRunEvent) => void) | undefined,
  deterministicPull: ConnectorIngestResult | undefined,
): void {
  if (!deterministicPull) {
    return;
  }

  emitText(
    emit,
    `${deterministicPull.message} Raw files: ${
      deterministicPull.rawFiles.length > 0
        ? deterministicPull.rawFiles.join(", ")
        : "none"
    }\n`,
  );
}

function emitText(
  emit: ((event: OpenWikiRunEvent) => void) | undefined,
  text: string,
): void {
  emit?.({
    source: "main",
    text,
    type: "text",
  });
}

function formatRawFileList(rawFiles: string[]): string {
  if (rawFiles.length === 0) {
    return "- (no raw files written)";
  }

  return rawFiles.map((filePath) => `- ${filePath}`).join("\n");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
