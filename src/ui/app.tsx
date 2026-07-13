import React, { useEffect, useRef, useState } from "react";
import { Box, useApp } from "ink";
import { createOpenWikiThreadId, runOpenWikiAgent } from "../agent/index.js";
import type { OpenWikiCommand } from "../agent/types.js";
import { ensureCodeModeRepoSetup } from "../code-mode.js";
import { getErrorDiagnostics } from "../cli/error-diagnostics.js";
import {
  getRunModeCwd,
  getRunModeOutputMode,
  shouldAutoExitStartupRun,
} from "../cli/run-mode.js";
import { type CliCommand, type OpenWikiRunMode } from "../cli/parse.js";
import {
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../constants.js";
import {
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderLabel,
  resolveConfiguredProvider,
  type OpenWikiProvider,
} from "../providers/config.js";
import { InitSetup, needsCredentialSetup } from "../credentials.js";
import { getErrorMessage } from "../diagnostics.js";
import {
  getCredentialDiagnostics,
  saveOpenWikiEnv,
  type CredentialDiagnostic,
} from "../env.js";
import { runOpenWikiIngestion } from "../ingestion.js";
import { ChatInput } from "./chat-input.js";
import { PromptBlock, StatusLine } from "./components.js";
import { isDebugMode, isExitMessage } from "./format.js";
import { Header } from "./header.js";
import {
  appendRunLogEvent,
  updateRunningCredentialDiagnostics,
} from "./run-log.js";
import { ChatHistory, RunView } from "./run-view.js";
import type { CompletedRun, RunLogItem, RunState } from "./types.js";
import {
  CredentialDiagnosticsPanel,
  DryRunView,
  ErrorDiagnosticsPanel,
  HelpView,
  IngestionSummary,
} from "./views.js";

/**
 * Props for {@link App}: the parsed CLI command that seeds the session.
 */
interface AppProps {
  command: CliCommand;
}

/**
 * The interactive terminal app: owns the run state, drives the agent for
 * init/update/chat/ingestion runs, renders the run log, credential setup, and
 * chat input, and manages provider/model selection for the session.
 */
export function App({ command }: AppProps) {
  const app = useApp();
  const startupModelId = command.kind === "run" ? command.modelId : null;
  const startupRunMode = command.kind === "run" ? command.mode : "personal";
  const [runMode, setRunMode] = useState<OpenWikiRunMode>(startupRunMode);
  const [codeRuntimeCwd, setCodeRuntimeCwd] = useState(process.cwd());
  const runtimeCwd = getRunModeCwd(runMode, codeRuntimeCwd);
  const runtimeOutputMode = getRunModeOutputMode(runMode);
  const startupProvider = resolveConfiguredProvider();
  const autoExitOnSuccess = shouldAutoExitStartupRun(command);
  const [sessionProvider, setSessionProvider] =
    useState<OpenWikiProvider>(startupProvider);
  const [sessionModelId, setSessionModelId] = useState<string | null>(
    startupModelId,
  );
  const activeRunId = useRef(0);
  const sessionThreadId = useRef(createOpenWikiThreadId(runtimeCwd));
  const sessionThreadMode = useRef<OpenWikiRunMode>(runMode);
  const mountedRef = useRef(false);
  const nextLogId = useRef(1);
  const nextCompletedRunId = useRef(1);
  const activeRunCredentialDiagnostics = useRef<
    CredentialDiagnostic[] | undefined
  >(undefined);
  const activeRunLog = useRef<RunLogItem[]>([]);
  const [runState, setRunState] = useState<RunState>({ status: "idle" });
  const [completedRuns, setCompletedRuns] = useState<CompletedRun[]>([]);
  const [activeUserMessage, setActiveUserMessage] = useState<string | null>(
    command.kind === "run" ? command.userMessage : null,
  );
  const [activeMessageIsFollowup, setActiveMessageIsFollowup] = useState(
    command.kind === "run" && command.command === "chat",
  );
  const shouldOpenSetupForExplicitModeChat =
    command.kind === "run" &&
    !command.dryRun &&
    !command.shouldStart &&
    command.modeSource !== "default" &&
    process.stdin.isTTY &&
    needsCredentialSetup(sessionModelId, runMode);
  const [resolvedCommand, setResolvedCommand] =
    useState<OpenWikiCommand | null>(
      command.kind === "run" &&
        (command.shouldStart || shouldOpenSetupForExplicitModeChat)
        ? command.command
        : null,
    );
  const shouldRunInteractiveCredentialSetup =
    command.kind === "run" &&
    resolvedCommand !== null &&
    !command.dryRun &&
    process.stdin.isTTY &&
    runState.status === "idle" &&
    needsCredentialSetup(sessionModelId, runMode);
  const displayModelId = sessionModelId ?? startupModelId;

  function submitChatMessage(message: string) {
    if (isExitMessage(message)) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    setActiveUserMessage(message);
    setActiveMessageIsFollowup(true);
    setResolvedCommand("chat");
    setRunState({ status: "idle" });
  }

  function submitCommandRun(
    nextCommand: Extract<OpenWikiCommand, "init" | "update">,
    message: string | null,
  ) {
    setActiveUserMessage(message);
    setActiveMessageIsFollowup(false);
    setResolvedCommand(nextCommand);
    setRunState({ status: "idle" });
  }

  function startIngestionRun(modelId: string | null) {
    const runId = activeRunId.current + 1;
    activeRunId.current = runId;
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    setResolvedCommand(null);
    setActiveUserMessage(
      "Run source-specific OpenWiki ingestion for configured sources.",
    );
    setActiveMessageIsFollowup(false);
    setRunState({
      status: "ingestion-running",
      log: [],
    });

    void runOpenWikiIngestion(process.cwd(), {
      debug: isDebugMode(),
      modelId,
      target: "all",
      onEvent: (event) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        activeRunLog.current = appendRunLogEvent(
          activeRunLog.current,
          event,
          nextLogId,
        );
        setRunState((currentState) =>
          currentState.status === "ingestion-running"
            ? {
                ...currentState,
                log: activeRunLog.current,
              }
            : currentState,
        );
      },
    })
      .then((result) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        if (
          result.results.some((sourceResult) => sourceResult.status === "error")
        ) {
          process.exitCode = 1;
        }

        setRunState({
          status: "ingestion-success",
          result,
          log: activeRunLog.current,
          credentialDiagnostics: activeRunCredentialDiagnostics.current,
        });
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        const errorDiagnostics = getErrorDiagnostics(error);
        const message = getErrorMessage(error);

        void getCredentialDiagnostics()
          .catch(() => undefined)
          .then((credentialDiagnostics) => {
            if (!mountedRef.current || activeRunId.current !== runId) {
              return;
            }

            setRunState({
              status: "error",
              message,
              credentialDiagnostics,
              errorDiagnostics,
            });
          });
      });
  }

  function clearSession() {
    activeRunId.current += 1;
    sessionThreadId.current = createOpenWikiThreadId(runtimeCwd);
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    nextLogId.current = 1;
    nextCompletedRunId.current = 1;
    setCompletedRuns([]);
    setActiveUserMessage(null);
    setActiveMessageIsFollowup(false);
    setResolvedCommand(null);
    setRunState({ status: "idle" });
  }

  async function selectModel(modelId: string) {
    await saveOpenWikiEnv({
      [OPENWIKI_MODEL_ID_ENV_KEY]: modelId,
    });
    setSessionModelId(modelId);
  }

  async function selectProvider(provider: OpenWikiProvider) {
    const modelId = getDefaultModelId(provider);

    await saveOpenWikiEnv({
      [OPENWIKI_PROVIDER_ENV_KEY]: provider,
      [OPENWIKI_MODEL_ID_ENV_KEY]: modelId,
    });
    setSessionProvider(provider);
    setSessionModelId(modelId);
  }

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (sessionThreadMode.current === runMode) {
      return;
    }

    sessionThreadId.current = createOpenWikiThreadId(runtimeCwd);
    sessionThreadMode.current = runMode;
  }, [runMode, runtimeCwd]);

  useEffect(() => {
    if (command.kind === "help" || command.kind === "error") {
      process.exitCode = command.exitCode;
      app.exit();
      return;
    }

    if (command.kind === "auth") {
      process.exitCode = command.exitCode;
      app.exit();
      return;
    }

    if (command.kind === "run" && command.dryRun) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    if (command.kind !== "run") {
      return;
    }

    if (resolvedCommand === null) {
      return;
    }

    const apiKeyEnvKey = getProviderApiKeyEnvKey(sessionProvider);

    if (!process.env[apiKeyEnvKey] && !process.stdin.isTTY) {
      setRunState({
        status: "error",
        message: `${apiKeyEnvKey} is required. Run openwiki in an interactive terminal to save credentials.`,
      });
      return;
    }

    if (shouldRunInteractiveCredentialSetup) {
      return;
    }

    if (runState.status !== "idle" && runState.status !== "init-setup-saved") {
      return;
    }

    const runId = activeRunId.current + 1;
    const runMessage = activeUserMessage;

    activeRunId.current = runId;
    activeRunCredentialDiagnostics.current = undefined;
    activeRunLog.current = [];
    setRunState({
      status: "running",
      command: resolvedCommand,
      log: [],
    });

    if (shouldShowCredentialDiagnostics()) {
      void getCredentialDiagnostics()
        .catch(() => undefined)
        .then((credentialDiagnostics) => {
          if (
            !mountedRef.current ||
            activeRunId.current !== runId ||
            !credentialDiagnostics
          ) {
            return;
          }

          setRunState((currentState) =>
            updateRunningCredentialDiagnostics(
              currentState,
              credentialDiagnostics,
              activeRunCredentialDiagnostics,
            ),
          );
        });
    }

    const setupPromise =
      runMode === "code"
        ? ensureCodeModeRepoSetup(runtimeCwd)
        : Promise.resolve();

    setupPromise
      .then(() =>
        runOpenWikiAgent(resolvedCommand, runtimeCwd, {
          debug: isDebugMode(),
          isFollowup: activeMessageIsFollowup,
          modelId: sessionModelId,
          outputMode: runtimeOutputMode,
          threadId: sessionThreadId.current,
          userMessage: activeUserMessage,
          onEvent: (event) => {
            if (!mountedRef.current || activeRunId.current !== runId) {
              return;
            }

            activeRunLog.current = appendRunLogEvent(
              activeRunLog.current,
              event,
              nextLogId,
            );
            setRunState((currentState) =>
              currentState.status === "running"
                ? {
                    ...currentState,
                    log: activeRunLog.current,
                  }
                : currentState,
            );
          },
        }),
      )
      .then((result) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        setRunState({
          status: "success",
          result,
          log: activeRunLog.current,
          credentialDiagnostics: activeRunCredentialDiagnostics.current,
        });
        setCompletedRuns((runs) => [
          ...runs,
          {
            id: nextCompletedRunId.current,
            command: result.command,
            credentialDiagnostics: activeRunCredentialDiagnostics.current,
            log: activeRunLog.current,
            message: runMessage,
            result,
          },
        ]);
        nextCompletedRunId.current += 1;
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || activeRunId.current !== runId) {
          return;
        }

        const errorDiagnostics = getErrorDiagnostics(error);
        const message = getErrorMessage(error);

        void getCredentialDiagnostics()
          .catch(() => undefined)
          .then((credentialDiagnostics) => {
            if (!mountedRef.current || activeRunId.current !== runId) {
              return;
            }

            setRunState({
              status: "error",
              message,
              credentialDiagnostics,
              errorDiagnostics,
            });
          });
      });
  }, [
    app,
    command,
    activeMessageIsFollowup,
    activeUserMessage,
    resolvedCommand,
    runMode,
    runState.status,
    runtimeCwd,
    runtimeOutputMode,
    sessionModelId,
    sessionProvider,
    shouldRunInteractiveCredentialSetup,
  ]);

  useEffect(() => {
    if (runState.status === "error") {
      process.exitCode = 1;
      app.exit();
      return;
    }

    if (runState.status === "success" && autoExitOnSuccess) {
      process.exitCode = 0;
      app.exit();
      return;
    }

    if (runState.status === "ingestion-success" && autoExitOnSuccess) {
      process.exitCode = runState.result.results.some(
        (sourceResult) => sourceResult.status === "error",
      )
        ? 1
        : 0;
      app.exit();
    }
  }, [app, autoExitOnSuccess, runState]);

  if (command.kind === "help") {
    return <HelpView />;
  }

  if (command.kind === "error") {
    return (
      <Box flexDirection="column">
        <Header modelId={null} subtitle="Command failed" />
        <StatusLine tone="error" label="Error" value={command.message} />
        <HelpView />
      </Box>
    );
  }

  if (command.kind === "run" && command.dryRun) {
    return (
      <DryRunView
        command={command.command}
        modelId={command.modelId}
        shouldStart={command.shouldStart}
        userMessage={command.userMessage}
      />
    );
  }

  if (shouldRunInteractiveCredentialSetup) {
    return (
      <InitSetup
        allowModeSelection={false}
        mode={command.mode}
        modelIdOverride={command.modelId}
        onComplete={(result) => {
          const nextCodeRuntimeCwd = result.repoRoot ?? codeRuntimeCwd;

          if (result.repoRoot) {
            setCodeRuntimeCwd(result.repoRoot);
          }

          if (result.mode !== runMode) {
            const nextRuntimeCwd = getRunModeCwd(
              result.mode,
              nextCodeRuntimeCwd,
            );
            sessionThreadId.current = createOpenWikiThreadId(nextRuntimeCwd);
            sessionThreadMode.current = result.mode;
            setRunMode(result.mode);
          } else if (result.repoRoot) {
            sessionThreadId.current = createOpenWikiThreadId(result.repoRoot);
            sessionThreadMode.current = result.mode;
          }

          if (result.modelId) {
            setSessionModelId(result.modelId);
          }
          if (result.provider) {
            setSessionProvider(result.provider);
          }

          if (!result.shouldContinueToRun) {
            activeRunId.current += 1;
            setResolvedCommand(null);
            setActiveUserMessage(null);
            setActiveMessageIsFollowup(false);
            setRunState({ status: "idle" });
            return;
          }

          if (result.runIngestionNow && result.mode === "code") {
            if (command.kind === "run" && !command.shouldStart) {
              setResolvedCommand("init");
            }
            setActiveMessageIsFollowup(false);
            setRunState({ status: "init-setup-saved", result });
            return;
          }

          if (result.runIngestionNow) {
            startIngestionRun(result.modelId ?? sessionModelId);
            return;
          }

          setRunState({ status: "init-setup-saved", result });
        }}
        onError={(message) => {
          setRunState({ status: "error", message });
        }}
      />
    );
  }

  if (runState.status === "init-setup-saved") {
    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.modelId ?? displayModelId}
          subtitle="Credential setup"
        />
        {runState.result.savedApiKey ||
        runState.result.savedProvider ||
        runState.result.savedBaseUrl ||
        runState.result.savedModelId ||
        runState.result.savedLangSmithKey ? (
          <StatusLine tone="success" label="Credentials" value="saved" />
        ) : null}
        {runState.result.provider ? (
          <StatusLine
            tone="muted"
            label="Provider"
            value={getProviderLabel(runState.result.provider)}
          />
        ) : null}
        {runState.result.modelId ? (
          <StatusLine
            tone="muted"
            label="Model"
            value={runState.result.modelId}
          />
        ) : null}
        <StatusLine tone="active" label="Next" value="starting openwiki" />
      </Box>
    );
  }

  if (runState.status === "setup-complete-exit") {
    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.modelId ?? displayModelId}
          subtitle="Setup complete"
        />
        <StatusLine
          tone="success"
          label="Setup"
          value="saved; waiting for scheduled ingestion"
        />
      </Box>
    );
  }

  if (runState.status === "running") {
    return (
      <Box flexDirection="column">
        <ChatHistory runs={completedRuns} />
        <RunView
          command={runState.command}
          credentialDiagnostics={runState.credentialDiagnostics}
          log={runState.log}
          message={activeUserMessage}
          modelId={displayModelId}
        />
      </Box>
    );
  }

  if (runState.status === "ingestion-running") {
    return (
      <Box flexDirection="column">
        <ChatHistory runs={completedRuns} />
        <RunView
          command="update"
          credentialDiagnostics={runState.credentialDiagnostics}
          log={runState.log}
          message={activeUserMessage}
          modelId={displayModelId}
        />
      </Box>
    );
  }

  if (runState.status === "ingestion-success") {
    return (
      <Box flexDirection="column">
        <Header modelId={displayModelId} subtitle="Ingestion complete" />
        <IngestionSummary result={runState.result} />
        <RunView
          command="update"
          credentialDiagnostics={runState.credentialDiagnostics}
          done
          log={runState.log}
          message={activeUserMessage}
          modelId={displayModelId}
        />
      </Box>
    );
  }

  if (runState.status === "success") {
    if (autoExitOnSuccess) {
      return (
        <RunView
          command={runState.result.command}
          credentialDiagnostics={runState.credentialDiagnostics}
          done
          log={runState.log}
          message={activeUserMessage}
          modelId={runState.result.model}
        />
      );
    }

    return (
      <Box flexDirection="column">
        <Header
          modelId={runState.result.model}
          subtitle="Ready for follow-up"
        />
        <ChatHistory runs={completedRuns} />
        <ChatInput
          currentModelId={getDisplayModelId(displayModelId)}
          currentProvider={sessionProvider}
          onClear={clearSession}
          onCommandRun={submitCommandRun}
          onModelSelect={selectModel}
          onProviderSelect={selectProvider}
          onSubmit={submitChatMessage}
        />
      </Box>
    );
  }

  if (runState.status === "idle" && completedRuns.length > 0) {
    return (
      <Box flexDirection="column">
        <Header modelId={displayModelId} subtitle="Starting follow-up" />
        <ChatHistory runs={completedRuns} />
        {activeUserMessage ? <PromptBlock message={activeUserMessage} /> : null}
        <StatusLine tone="active" label="Next" value="starting openwiki" />
      </Box>
    );
  }

  if (runState.status === "error") {
    return (
      <Box flexDirection="column">
        <Header modelId={displayModelId} subtitle="Run failed" />
        <StatusLine tone="error" label="Error" value={runState.message} />
        {runState.credentialDiagnostics ? (
          <CredentialDiagnosticsPanel
            diagnostics={runState.credentialDiagnostics}
          />
        ) : null}
        {runState.errorDiagnostics && runState.errorDiagnostics.length > 0 ? (
          <ErrorDiagnosticsPanel diagnostics={runState.errorDiagnostics} />
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header modelId={displayModelId} subtitle="Ready for chat" />
      <ChatInput
        currentModelId={getDisplayModelId(displayModelId)}
        currentProvider={sessionProvider}
        onClear={clearSession}
        onCommandRun={submitCommandRun}
        onModelSelect={selectModel}
        onProviderSelect={selectProvider}
        onSubmit={submitChatMessage}
      />
    </Box>
  );
}

function shouldShowCredentialDiagnostics(): boolean {
  return isDebugMode() || process.env.OPENWIKI_DEBUG_CREDENTIALS === "1";
}

function getDisplayModelId(modelId: string | null): string {
  return (
    modelId ??
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
    getDefaultModelId(resolveConfiguredProvider())
  );
}
