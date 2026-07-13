import { Box, Text } from "ink";
import type { ErrorDiagnostic } from "../cli/error-diagnostics.js";
import { helpContent } from "../cli/help.js";
import { isDevelopmentMode } from "../cli/parse.js";
import {
  getDefaultModelId,
  resolveConfiguredProvider,
} from "../providers/config.js";
import type { OpenWikiCommand } from "../agent/types.js";
import type { CredentialDiagnostic } from "../env.js";
import type { OpenWikiIngestionResult } from "../ingestion.js";
import { Panel, Rows, StatusLine } from "./components.js";
import { Header } from "./header.js";

/**
 * The `--help` screen: the header followed by usage, commands, options, and
 * examples panels (development-only sections appear in development mode).
 */
export function HelpView() {
  return (
    <Box flexDirection="column">
      <Header modelId={null} subtitle={helpContent.description} />

      <Panel title="Usage">
        {helpContent.usage.map((line) => (
          <Text key={line}> {line}</Text>
        ))}
      </Panel>

      <Panel title="Commands">
        <Rows rows={helpContent.commands} />
      </Panel>

      <Panel title="Options">
        <Rows rows={helpContent.options} />
      </Panel>

      {isDevelopmentMode() ? (
        <Panel title="Development Options">
          <Rows rows={helpContent.developmentOptions} />
        </Panel>
      ) : null}

      <Panel title="Examples">
        {helpContent.examples.map((line) => (
          <Text key={line}> {line}</Text>
        ))}
        {isDevelopmentMode()
          ? helpContent.developmentExamples.map((line) => (
              <Text key={line}> {line}</Text>
            ))
          : null}
      </Panel>
    </Box>
  );
}

/**
 * The development dry-run screen: shows what a run would do (mode, model,
 * output, startup) without reading credentials or invoking the agent.
 */
export function DryRunView({
  command,
  modelId,
  shouldStart,
  userMessage,
}: {
  command: OpenWikiCommand;
  modelId: string | null;
  shouldStart: boolean;
  userMessage: string | null;
}) {
  return (
    <Box flexDirection="column">
      <Header modelId={modelId} subtitle="Development dry run" />
      <Panel title="Execution Plan">
        <StatusLine
          tone="active"
          label="Command"
          value={`openwiki ${command}`}
        />
        <StatusLine tone="muted" label="Mode" value={command} />
        <StatusLine
          tone="muted"
          label="Credentials"
          value="not read or requested"
        />
        <StatusLine
          tone="muted"
          label="Model"
          value={
            modelId ??
            `saved setting or ${getDefaultModelId(resolveConfiguredProvider())}`
          }
        />
        <StatusLine tone="muted" label="Agent" value="not invoked" />
        <StatusLine tone="muted" label="Writes" value="no files or metadata" />
        <StatusLine tone="muted" label="Output" value="~/.openwiki/wiki" />
        <StatusLine
          tone="muted"
          label="Startup"
          value={shouldStart ? "would start run" : "would open chat"}
        />
        {userMessage ? (
          <StatusLine tone="muted" label="Message" value={userMessage} />
        ) : null}
      </Panel>
    </Box>
  );
}

/**
 * Debug panel listing each managed credential's source, length, masked preview,
 * and warnings. Raw secret values are never shown.
 */
export function CredentialDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: CredentialDiagnostic[];
}) {
  return (
    <Panel title="Credential Diagnostics">
      <Text color="gray">Raw secret values are intentionally not printed.</Text>
      {diagnostics.map((diagnostic) => (
        <Box flexDirection="column" key={diagnostic.key} marginTop={1}>
          <Text>
            <Text bold>{diagnostic.key}</Text>{" "}
            <Text color="gray">source={diagnostic.source}</Text>
          </Text>
          <Text>
            length={diagnostic.length ?? "unset"} preview={diagnostic.preview}
          </Text>
          <Text color={diagnostic.warnings.length > 0 ? "yellow" : "gray"}>
            warnings=
            {diagnostic.warnings.length > 0
              ? diagnostic.warnings.join(", ")
              : "none"}
          </Text>
        </Box>
      ))}
    </Panel>
  );
}

/**
 * Debug panel listing the allowlisted, non-secret fields of a run error, shown
 * when `OPENWIKI_DEBUG=1`.
 */
export function ErrorDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: ErrorDiagnostic[];
}) {
  return (
    <Panel title="Error Diagnostics">
      <Text color="gray">
        OPENWIKI_DEBUG=1 is enabled. Only allowlisted, non-secret error fields
        are shown.
      </Text>
      {diagnostics.map((diagnostic) => (
        <Text key={diagnostic.label}>
          <Text bold>{diagnostic.label}</Text> {diagnostic.value}
        </Text>
      ))}
    </Panel>
  );
}

/**
 * Per-source summary of an ingestion run: one status line per source with its
 * status and raw-file count.
 */
export function IngestionSummary({
  result,
}: {
  result: OpenWikiIngestionResult;
}) {
  return (
    <Panel title="Source Runs">
      {result.results.map((sourceResult) => (
        <StatusLine
          key={sourceResult.sourceInstanceId}
          label={sourceResult.displayName}
          tone={sourceResult.status === "error" ? "error" : "success"}
          value={`${sourceResult.status}; ${sourceResult.rawFiles.length} raw file(s)`}
        />
      ))}
    </Panel>
  );
}
