import { spawn } from "node:child_process";
import React, { useEffect, useMemo, useRef, useState } from "react";
import path from "node:path";
import { Box, Text, useInput, useStdout } from "ink";
import { configureAuthProvider } from "../../auth/configure.js";
import { runOAuthAuth } from "../../auth/oauth.js";
import {
  DEFAULT_PROVIDER,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../../constants.js";
import {
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  isValidBaseUrl,
  type OpenWikiProvider,
  providerRequiresBaseUrl,
  providerUsesOAuth,
  resolveConfiguredProvider,
  SELECTABLE_OPENWIKI_PROVIDERS,
} from "../../providers/config.js";
import {
  getModelSelectionIndex,
  getModelSelectionOptions,
  getModelSetupDetail,
  getProviderSelectionIndex,
  getProviderSetupDetail,
  getSelectedModelId,
  shouldStartWithCustomModelInput,
} from "../../providers/model-selection.js";
import {
  type ChatGptLoginHandle,
  type CodexTokens,
  codexTokensToEnv,
  loginWithChatGPT,
} from "../../agent/openai-chatgpt-oauth.js";
import type { OpenWikiRunMode } from "../../cli/parse.js";
import {
  credentialStep,
  getCredentialSetupDetail,
  getDefaultCodeRepoRootPath,
  getDefaultLocalGitRepoPath,
  getInitialStep,
  getNextStepAfterApiKey,
  getNextStepAfterBaseUrl,
  getNextStepAfterProvider,
  hasValidConfiguredProvider,
  isBaseUrlConfigured,
  isCredentialConfigured,
  isScheduleStep,
  isSourceStep,
  needsBaseUrlStep,
  needsCredentialStep,
  normalizeLocalPath,
  type PromptStep,
  sanitizeRepoId,
  validateLocalDirectoryPath,
} from "../../config/credentials.js";
import {
  CRON_FIELD_LABELS,
  getCronFields,
  getSuggestedCronExpression,
  parseCronFieldPaste,
  sanitizeCronInputChunk,
  validateCronExpression,
} from "../../schedules/cron.js";
import {
  getErrorMessage,
  getInputDisplayWidth,
  moveSelectionIndex,
  sanitizeInputChunk,
} from "./input-utils.js";
import {
  OAuthLoginPrompt,
  SetupHeader,
  SetupPanel,
  SetupStep,
} from "./components.js";
import {
  CODE_REPO_OPTIONS,
  CRON_MODE_OPTIONS,
  POWER_MODE_OPTIONS,
  SOURCE_CONTINUE_OPTIONS,
} from "./constants.js";
import type { SourceSetupState } from "./types.js";
import { Prompt } from "./prompt.js";
import type { ConnectorId, SourceSetupOption } from "../../connectors/types.js";
import {
  getSourceDescriptionOptionCount,
  getSourceOption,
  getStaticSourceConfig,
  getTemplateSourceOptions,
  needsEnvValue,
} from "../../connectors/source-catalog.js";
import { getConnectorConfigPath } from "../../openwiki-home.js";
import { openWikiEnvPath, saveOpenWikiEnv } from "../../env.js";
import {
  createEmptyOnboardingConfig,
  isOnboardingComplete,
  openWikiOnboardingPath,
  readOpenWikiOnboardingConfig,
  saveRepositoryWikiInstructions,
  saveOpenWikiOnboardingConfig,
  type OpenWikiOnboardingConfig,
} from "../../onboarding/store.js";
import {
  addSourceInstanceConfig,
  createSourceInstanceId,
  createSourceInstanceName,
  ensureRunModeConfig,
  FINAL_OPTIONS,
  getConfigModeId,
  getConfigModeName,
  getConnectedSourceCount,
  getRunModeName,
  getRunModeSelectionIndex,
  getTemplateGoal,
  hydrateRunModeConfig,
  isCodeMode,
  ONBOARDING_TEMPLATES,
  RUN_MODE_OPTIONS,
} from "../../onboarding/setup.js";
import { installConnectorSchedule } from "../../schedules/connectors.js";
import { installOpenWikiPowerSchedule } from "../../schedules/power.js";

export type InitSetupResult = {
  mode: OpenWikiRunMode;
  modelId: string | null;
  onboardingCompleted: boolean;
  provider: OpenWikiProvider | null;
  repoRoot?: string;
  runIngestionNow: boolean;
  savedApiKey: boolean;
  savedBaseUrl: boolean;
  savedLangSmithKey: boolean;
  savedModelId: boolean;
  savedProvider: boolean;
  shouldContinueToRun: boolean;
};

type InitSetupProps = {
  allowModeSelection?: boolean;
  mode: OpenWikiRunMode;
  modelIdOverride?: string | null;
  onComplete: (result: InitSetupResult) => void;
  onError: (message: string) => void;
};

type PromptInputKey = {
  backspace?: boolean;
  ctrl?: boolean;
  delete?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  meta?: boolean;
  return?: boolean;
  rightArrow?: boolean;
  tab?: boolean;
  upArrow?: boolean;
};

/**
 * Copies text to the terminal's clipboard using the OSC 52 escape sequence.
 * This targets the user's local terminal emulator even when OpenWiki runs over
 * SSH, unlike shelling out to a host clipboard utility.
 */
function copyToClipboard(text: string): void {
  const encoded = Buffer.from(text, "utf8").toString("base64");

  process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
}

function openLoginUrl(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", '""', `"${url}"`], {
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
          })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          });

    child.on("error", () => {
      // The URL is also rendered for manual use on headless/SSH machines.
    });
    child.unref();
  } catch {
    // Ignore spawn failures; the URL is still rendered for manual use.
  }
}

export function InitSetup({
  allowModeSelection = false,
  mode,
  modelIdOverride = null,
  onComplete,
  onError,
}: InitSetupProps) {
  const { stdout } = useStdout();
  const initialProvider = resolveConfiguredProvider();
  const [step, setStep] = useState<PromptStep | null>(null);
  const [selectedMode, setSelectedMode] = useState<OpenWikiRunMode>(mode);
  const [provider, setProvider] = useState<OpenWikiProvider>(initialProvider);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [langSmithKey, setLangSmithKey] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [onboardingConfig, setOnboardingConfig] =
    useState<OpenWikiOnboardingConfig>(() => createEmptyOnboardingConfig());
  const [sourceState, setSourceState] = useState<SourceSetupState>({
    secretValues: {},
  });
  const [selectedSourceId, setSelectedSourceId] =
    useState<ConnectorId>("git-repo");
  const [secretInputIndex, setSecretInputIndex] = useState(0);
  const [providerSelectionIndex, setProviderSelectionIndex] = useState(() =>
    getProviderSelectionIndex(initialProvider),
  );
  const [modelSelectionIndex, setModelSelectionIndex] = useState(() =>
    getModelSelectionIndex(
      initialProvider,
      modelIdOverride ??
        process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
        getDefaultModelId(initialProvider),
    ),
  );
  const [runModeSelectionIndex, setRunModeSelectionIndex] = useState(() =>
    getRunModeSelectionIndex(mode),
  );
  const [sourceSelectionIndex, setSourceSelectionIndex] = useState(0);
  const [sourceDescriptionSelectionIndex, setSourceDescriptionSelectionIndex] =
    useState(0);
  const [templateSelectionIndex, setTemplateSelectionIndex] = useState(0);
  const [cronModeSelectionIndex, setCronModeSelectionIndex] = useState(0);
  const [powerModeSelectionIndex, setPowerModeSelectionIndex] = useState(0);
  const [cronFieldSelectionIndex, setCronFieldSelectionIndex] = useState(0);
  const [cronReplaceCurrentField, setCronReplaceCurrentField] = useState(true);
  const [sourceContinueSelectionIndex, setSourceContinueSelectionIndex] =
    useState(0);
  const [finalSelectionIndex, setFinalSelectionIndex] = useState(0);
  const [codeRepoSelectionIndex, setCodeRepoSelectionIndex] = useState(0);
  const [codeRepoRoot, setCodeRepoRoot] = useState(() =>
    getDefaultCodeRepoRootPath(),
  );
  const [codeRepoConfirmed, setCodeRepoConfirmed] = useState(false);
  const [isCustomModelInput, setIsCustomModelInput] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAuthRunning, setIsAuthRunning] = useState(false);
  const [oauthTokens, setOauthTokens] = useState<CodexTokens | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginAttempt, setLoginAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [forceModelStep, setForceModelStep] = useState(false);
  const loginHandleRef = useRef<ChatGptLoginHandle | null>(null);

  const activeSourceOptions = useMemo(
    () => getTemplateSourceOptions(getConfigModeId(onboardingConfig)),
    [onboardingConfig.modeId, onboardingConfig.templateId],
  );
  const selectedSource = getSourceOption(selectedSourceId);
  const suggestedCronExpression = useMemo(
    () => getSuggestedCronExpression(onboardingConfig),
    [onboardingConfig],
  );
  const suggestedCronDescription = useMemo(() => {
    const validation = validateCronExpression(suggestedCronExpression);
    return validation.valid ? validation.description : suggestedCronExpression;
  }, [suggestedCronExpression]);
  const inputDisplayWidth = getInputDisplayWidth(stdout.columns);

  useEffect(() => {
    let cancelled = false;

    readOpenWikiOnboardingConfig()
      .then(async (config) => {
        if (cancelled) {
          return;
        }

        const defaultRepoRoot = getDefaultCodeRepoRootPath();
        const configForMode = allowModeSelection
          ? config
          : await hydrateRunModeConfig(
              ensureRunModeConfig(config, mode),
              mode,
              defaultRepoRoot,
            );
        if (configForMode !== config) {
          await saveOpenWikiOnboardingConfig({
            ...configForMode,
            wikiGoal: mode === "code" ? undefined : configForMode.wikiGoal,
          });
        }
        setOnboardingConfig(configForMode);
        const initialStep = getInitialStep(
          modelIdOverride,
          initialProvider,
          configForMode,
          mode,
          allowModeSelection,
        );

        if (initialStep === null) {
          onComplete({
            mode,
            modelId:
              modelIdOverride ?? process.env[OPENWIKI_MODEL_ID_ENV_KEY] ?? null,
            onboardingCompleted: true,
            provider: initialProvider,
            runIngestionNow: false,
            savedApiKey: false,
            savedBaseUrl: false,
            savedLangSmithKey: false,
            savedModelId: false,
            savedProvider: false,
            shouldContinueToRun: true,
          });
          return;
        }

        setProvider(initialProvider);
        setProviderSelectionIndex(getProviderSelectionIndex(initialProvider));
        setModelSelectionIndex(
          getModelSelectionIndex(
            initialProvider,
            modelIdOverride ??
              process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
              getDefaultModelId(initialProvider),
          ),
        );
        setIsCustomModelInput(
          initialStep === "model" &&
            shouldStartWithCustomModelInput(initialProvider),
        );
        if (initialStep === "wiki-goal") {
          setInput(getTemplateGoal(getConfigModeId(config)));
        }
        if (initialStep === "code-repo-confirm") {
          setCodeRepoRoot(defaultRepoRoot);
          setCodeRepoSelectionIndex(0);
        }
        setStep(initialStep);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          onError(getErrorMessage(loadError));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    allowModeSelection,
    initialProvider,
    modelIdOverride,
    onComplete,
    onError,
    mode,
  ]);

  // Drive the browser OAuth login whenever the wizard enters the oauth-login
  // step or the user retries after a failure.
  useEffect(() => {
    if (step !== "oauth-login") {
      return;
    }

    let cancelled = false;

    setIsLoggingIn(true);
    setLoginUrl(null);
    setCopied(false);
    setInput("");
    setError(null);
    loginHandleRef.current = null;

    void (async () => {
      try {
        const tokens = await loginWithChatGPT(
          (url) => {
            if (cancelled) {
              return;
            }

            setLoginUrl(url);
            openLoginUrl(url);
          },
          (handle) => {
            if (!cancelled) {
              loginHandleRef.current = handle;
            }
          },
        );

        if (cancelled) {
          return;
        }

        setOauthTokens(tokens);
        setIsLoggingIn(false);

        const nextStep = getNextStepAfterApiKey(
          provider,
          modelIdOverride,
          onboardingConfig,
          selectedMode,
          forceModelStep,
        );

        if (nextStep) {
          setIsCustomModelInput(
            nextStep === "model" && shouldStartWithCustomModelInput(provider),
          );
          setStep(nextStep);
          return;
        }

        await completeSetup({
          nextApiKey: apiKey,
          nextBaseUrl: baseUrl,
          nextLangSmithKey: langSmithKey,
          nextModelId: modelId,
          nextOAuthTokens: tokens,
          nextProvider: provider,
          runMode: selectedMode,
        });
      } catch (loginError) {
        if (cancelled) {
          return;
        }

        setIsLoggingIn(false);
        setError(getErrorMessage(loginError));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [step, loginAttempt]);

  useInput((inputValue, key) => {
    if (
      isSaving ||
      isAuthRunning ||
      (isLoggingIn && step !== "oauth-login") ||
      step === null
    ) {
      return;
    }

    if (step === "oauth-login") {
      if (
        input.length === 0 &&
        (inputValue === "c" || inputValue === "C") &&
        !key.ctrl &&
        !key.meta
      ) {
        if (loginUrl) {
          copyToClipboard(loginUrl);
          setCopied(true);
        }

        return;
      }

      if (key.return) {
        const pasted = input.trim();

        if (pasted.length > 0) {
          submitManualLogin(pasted);
        } else if (!isLoggingIn) {
          setLoginAttempt((attempt) => attempt + 1);
        }

        return;
      }

      if (key.backspace || key.delete) {
        setInput((value) => value.slice(0, -1));
        return;
      }

      const sanitizedInput = sanitizeInputChunk(inputValue);

      if (sanitizedInput && !key.ctrl && !key.meta) {
        setError(null);
        setInput((value) => value + sanitizedInput);
      }

      return;
    }

    if (step === "provider") {
      handleMenuInput(key, () =>
        setProviderSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            SELECTABLE_OPENWIKI_PROVIDERS.length,
          ),
        ),
      );
      return;
    }

    if (step === "model" && !isCustomModelInput) {
      handleMenuInput(key, () =>
        setModelSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            getModelSelectionOptions(provider).length,
          ),
        ),
      );
      return;
    }

    if (step === "run-mode") {
      handleMenuInput(key, () =>
        setRunModeSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            RUN_MODE_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "code-repo-confirm") {
      handleMenuInput(key, () =>
        setCodeRepoSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            CODE_REPO_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "source-menu") {
      handleMenuInput(key, () =>
        setSourceSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            activeSourceOptions.length + 1,
          ),
        ),
      );
      return;
    }

    if (step === "template") {
      handleMenuInput(key, () =>
        setTemplateSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            ONBOARDING_TEMPLATES.length,
          ),
        ),
      );
      return;
    }

    if (step === "global-cron-mode") {
      handleMenuInput(key, () =>
        setCronModeSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            CRON_MODE_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "global-power-mode") {
      handleMenuInput(key, () =>
        setPowerModeSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            POWER_MODE_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "source-description") {
      handleMenuInput(key, () =>
        setSourceDescriptionSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            getSourceDescriptionOptionCount(selectedSource),
          ),
        ),
      );
      return;
    }

    if (step === "source-confirm-continue") {
      handleMenuInput(key, () =>
        setSourceContinueSelectionIndex((index) =>
          moveSelectionIndex(
            index,
            key.upArrow ? -1 : 1,
            SOURCE_CONTINUE_OPTIONS.length,
          ),
        ),
      );
      return;
    }

    if (step === "final") {
      handleMenuInput(key, () =>
        setFinalSelectionIndex((index) =>
          moveSelectionIndex(index, key.upArrow ? -1 : 1, FINAL_OPTIONS.length),
        ),
      );
      return;
    }

    if (step === "source-auth") {
      if (key.return) {
        void submit();
      }
      return;
    }

    if (step === "global-cron-custom") {
      if (key.return) {
        void submit();
        return;
      }

      const didHandleCronInput = handleCronEditorInput({
        currentFieldIndex: cronFieldSelectionIndex,
        currentValue: input,
        fallbackExpression: suggestedCronExpression,
        inputValue,
        key,
        replaceCurrentField: cronReplaceCurrentField,
        setCurrentFieldIndex: setCronFieldSelectionIndex,
        setReplaceCurrentField: setCronReplaceCurrentField,
        setValue: setInput,
      });

      if (didHandleCronInput) {
        setError(null);
      }

      return;
    }

    if (step === "code-repo-path") {
      if (key.return) {
        void submit();
        return;
      }

      if (key.backspace || key.delete) {
        setInput((value) => value.slice(0, -1));
        return;
      }

      const sanitizedInput = sanitizeInputChunk(inputValue);

      if (sanitizedInput && !key.ctrl && !key.meta) {
        setError(null);
        setInput((value) => value + sanitizedInput);
      }

      return;
    }

    if (key.return) {
      void submit();
      return;
    }

    if (key.backspace || key.delete) {
      setInput((value) => value.slice(0, -1));
      return;
    }

    const sanitizedInput = sanitizeInputChunk(inputValue);

    if (sanitizedInput && !key.ctrl && !key.meta) {
      setInput((value) => value + sanitizedInput);
    }
  });

  function handleMenuInput(key: PromptInputKey, move: () => void) {
    if (key.upArrow || key.downArrow) {
      setError(null);
      move();
      return;
    }

    if (key.return) {
      void submit();
    }
  }

  async function submit() {
    setError(null);
    setNotice(null);

    if (step === "run-mode") {
      const selectedOption =
        RUN_MODE_OPTIONS[runModeSelectionIndex] ?? RUN_MODE_OPTIONS[0];

      setSelectedMode(selectedOption.id);
      setRunModeSelectionIndex(getRunModeSelectionIndex(selectedOption.id));
      setInput("");
      const nextOnboardingConfig = ensureRunModeConfig(
        onboardingConfig,
        selectedOption.id,
      );

      if (nextOnboardingConfig !== onboardingConfig) {
        await saveConfig(nextOnboardingConfig);
      }

      const nextStep = getInitialStep(
        modelIdOverride,
        provider,
        nextOnboardingConfig,
        selectedOption.id,
        false,
      );

      if (nextStep) {
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedOption.id,
      });
      return;
    }

    if (step === "code-repo-confirm") {
      const selectedOption =
        CODE_REPO_OPTIONS[codeRepoSelectionIndex] ?? CODE_REPO_OPTIONS[0];

      if (selectedOption === "Edit path") {
        setInput(codeRepoRoot);
        setStep("code-repo-path");
        return;
      }

      setCodeRepoConfirmed(true);
      continueAfterCodeRepoConfirmed(codeRepoRoot);
      return;
    }

    if (step === "code-repo-path") {
      try {
        const repoRoot = await validateLocalDirectoryPath(input);
        setCodeRepoRoot(repoRoot);
        setCodeRepoConfirmed(true);
        setInput("");
        continueAfterCodeRepoConfirmed(repoRoot);
      } catch (pathError) {
        setError(getErrorMessage(pathError));
      }
      return;
    }

    if (step === "provider") {
      const selectedProvider =
        SELECTABLE_OPENWIKI_PROVIDERS[providerSelectionIndex] ??
        DEFAULT_PROVIDER;

      setProvider(selectedProvider);
      setProviderSelectionIndex(getProviderSelectionIndex(selectedProvider));
      setModelSelectionIndex(
        getModelSelectionIndex(
          selectedProvider,
          getDefaultModelId(selectedProvider),
        ),
      );
      setInput("");
      const providerChanged =
        process.env[OPENWIKI_PROVIDER_ENV_KEY] !== selectedProvider;
      setForceModelStep(providerChanged);
      const nextStep = getNextStepAfterProvider(
        selectedProvider,
        modelIdOverride,
        onboardingConfig,
        selectedMode,
        providerChanged,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" &&
            shouldStartWithCustomModelInput(selectedProvider),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: selectedProvider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "api-key") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        setError(`${getProviderApiKeyEnvKey(provider)} is required.`);
        return;
      }

      setApiKey(trimmedInput);
      setInput("");
      const nextStep = getNextStepAfterApiKey(
        provider,
        modelIdOverride,
        onboardingConfig,
        selectedMode,
        forceModelStep,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: trimmedInput,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "base-url") {
      const trimmedInput = input.trim();

      if (trimmedInput.length === 0) {
        setError(
          `${getProviderBaseUrlEnvKey(provider) ?? "Base URL"} is required.`,
        );
        return;
      }

      if (!isValidBaseUrl(trimmedInput)) {
        setError("Enter a valid http(s) base URL.");
        return;
      }

      setBaseUrl(trimmedInput);
      setInput("");
      const nextStep = getNextStepAfterBaseUrl(
        provider,
        modelIdOverride,
        onboardingConfig,
        selectedMode,
        forceModelStep,
      );

      if (nextStep) {
        setIsCustomModelInput(
          nextStep === "model" && shouldStartWithCustomModelInput(provider),
        );
        setStep(nextStep);
        return;
      }

      await completeSetup({
        nextApiKey: apiKey,
        nextBaseUrl: trimmedInput,
        nextLangSmithKey: langSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "model") {
      const selectedModelId = getSelectedModelId(
        provider,
        modelSelectionIndex,
        input,
        isCustomModelInput,
      );

      if (!selectedModelId) {
        setError("Paste a valid model ID.");
        return;
      }

      if (selectedModelId === "custom") {
        setIsCustomModelInput(true);
        setInput("");
        return;
      }

      setModelId(selectedModelId);
      setInput("");
      setIsCustomModelInput(false);

      if (process.env.LANGSMITH_API_KEY === undefined) {
        setStep("langsmith");
        return;
      }

      await continueAfterCredentials({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey: langSmithKey,
        nextModelId: selectedModelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "langsmith") {
      const nextLangSmithKey = input.trim();

      setLangSmithKey(nextLangSmithKey);
      setInput("");

      await continueAfterCredentials({
        nextApiKey: apiKey,
        nextBaseUrl: baseUrl,
        nextLangSmithKey,
        nextModelId: modelId,
        nextOAuthTokens: oauthTokens,
        nextProvider: provider,
        runMode: selectedMode,
      });
      return;
    }

    if (step === "wiki-goal") {
      const wikiGoal = input.trim();

      if (wikiGoal.length === 0) {
        setError("Describe what this wiki should understand.");
        return;
      }

      const nextConfig = {
        ...onboardingConfig,
        wikiGoal,
      };
      await saveConfigForCurrentMode(nextConfig);
      setInput("");

      if (isCodeMode(nextConfig)) {
        setStep("final");
        return;
      }

      setCronModeSelectionIndex(0);
      setCronFieldSelectionIndex(0);
      setCronReplaceCurrentField(true);
      setStep("global-cron-mode");
      return;
    }

    if (step === "template") {
      const selectedTemplate =
        ONBOARDING_TEMPLATES[templateSelectionIndex] ?? ONBOARDING_TEMPLATES[0];
      const nextConfig = {
        ...onboardingConfig,
        modeId: selectedTemplate.id,
        modeName: selectedTemplate.name,
        templateId: selectedTemplate.id,
        templateName: selectedTemplate.name,
      };
      await saveConfig(nextConfig);
      setInput(selectedTemplate.suggestedGoal);
      setStep("wiki-goal");
      return;
    }

    if (step === "source-menu") {
      if (sourceSelectionIndex >= activeSourceOptions.length) {
        if (
          getConnectedSourceCount(onboardingConfig, activeSourceOptions) > 0
        ) {
          setStep("final");
          return;
        }

        setSourceContinueSelectionIndex(0);
        setStep("source-confirm-continue");
        return;
      }

      const source =
        activeSourceOptions[sourceSelectionIndex] ?? activeSourceOptions[0];
      const firstMissingSecretIndex = source.secretInputs.findIndex((secret) =>
        needsEnvValue(secret),
      );
      setSelectedSourceId(source.id);
      setSourceState({ secretValues: {} });
      setSourceDescriptionSelectionIndex(0);
      setSecretInputIndex(
        firstMissingSecretIndex === -1 ? 0 : firstMissingSecretIndex,
      );
      setInput("");
      setCronModeSelectionIndex(0);
      setPowerModeSelectionIndex(0);
      setCronFieldSelectionIndex(0);
      setCronReplaceCurrentField(true);

      if (
        source.secretInputs.some((secretInput) => needsEnvValue(secretInput))
      ) {
        setStep("source-secret");
        return;
      }

      continueAfterSourceCredentialSetup(source);
      return;
    }

    if (step === "source-secret") {
      const currentSecretInput = selectedSource.secretInputs[secretInputIndex];
      if (!currentSecretInput) {
        continueAfterSourceCredentialSetup(selectedSource);
        return;
      }

      const trimmedInput = input.trim();
      if (trimmedInput.length === 0 && !currentSecretInput.optional) {
        setError(`${currentSecretInput.envKey} is required.`);
        return;
      }

      const nextSecretValues = {
        ...sourceState.secretValues,
        ...(trimmedInput.length > 0
          ? { [currentSecretInput.envKey]: trimmedInput }
          : {}),
      };
      setSourceState((state) => ({
        ...state,
        secretValues: nextSecretValues,
      }));
      setInput("");

      const nextIndex = secretInputIndex + 1;
      const nextMissingIndex = selectedSource.secretInputs.findIndex(
        (secretInput, index) =>
          index >= nextIndex &&
          needsEnvValue(secretInput) &&
          nextSecretValues[secretInput.envKey] === undefined,
      );

      if (nextMissingIndex !== -1) {
        setSecretInputIndex(nextMissingIndex);
        return;
      }

      await saveOpenWikiEnv(nextSecretValues);
      continueAfterSourceCredentialSetup(selectedSource);
      return;
    }

    if (step === "source-auth") {
      await authorizeSelectedSource();
      return;
    }

    if (step === "source-path") {
      const repoPath = normalizeLocalPath(input);

      if (repoPath.length === 0) {
        setError("Enter a local repository directory.");
        return;
      }

      try {
        const connectorConfig = await configureLocalGitRepo(repoPath);
        setSourceState((state) => ({ ...state, connectorConfig }));
        setInput("");
        setStep("source-description");
      } catch (setupError) {
        setError(getErrorMessage(setupError));
      }
      return;
    }

    if (step === "source-description") {
      if (sourceDescriptionSelectionIndex >= selectedSource.examples.length) {
        setInput("");
        setStep("source-description-custom");
        return;
      }

      const selectedExample =
        selectedSource.examples[sourceDescriptionSelectionIndex] ?? "";
      await saveSelectedSourceDescription(selectedExample);
      return;
    }

    if (step === "source-description-custom") {
      await saveSelectedSourceDescription(input.trim());
      return;
    }

    if (step === "global-cron-mode") {
      const selectedMode = CRON_MODE_OPTIONS[cronModeSelectionIndex];

      if (selectedMode === "Enter custom cron") {
        setInput(suggestedCronExpression);
        setCronFieldSelectionIndex(0);
        setCronReplaceCurrentField(true);
        setStep("global-cron-custom");
        return;
      }

      await saveModeSchedule(suggestedCronExpression);
      return;
    }

    if (step === "global-cron-custom") {
      const validation = validateCronExpression(input);

      if (!validation.valid) {
        setError(validation.error);
        return;
      }

      await saveModeSchedule(validation.expression);
      return;
    }

    if (step === "global-power-mode") {
      const selectedMode = POWER_MODE_OPTIONS[powerModeSelectionIndex];

      if (selectedMode === "Set up Mac wake/sleep window") {
        await saveGlobalMacPowerWindow();
        return;
      }

      setSourceSelectionIndex(0);
      setSourceState({ secretValues: {} });
      setInput("");
      setStep("source-menu");
      return;
    }

    if (step === "source-confirm-continue") {
      const selectedAction =
        SOURCE_CONTINUE_OPTIONS[sourceContinueSelectionIndex];
      if (selectedAction === "Go back to connections") {
        returnToSourceMenu();
        setStep("source-menu");
        return;
      }

      setStep("final");
      return;
    }

    if (step === "final") {
      const runIngestionNow =
        FINAL_OPTIONS[finalSelectionIndex] === "Run ingestion now";
      const nextConfig = {
        ...onboardingConfig,
        completedAt: new Date().toISOString(),
      };
      await saveConfigForCurrentMode(nextConfig);
      onComplete({
        mode: selectedMode,
        modelId:
          modelId ??
          modelIdOverride ??
          process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
          null,
        onboardingCompleted: true,
        provider,
        repoRoot:
          selectedMode === "code" && codeRepoConfirmed
            ? codeRepoRoot
            : undefined,
        runIngestionNow,
        savedApiKey: apiKey !== null || oauthTokens !== null,
        savedBaseUrl: baseUrl !== null,
        savedLangSmithKey: langSmithKey !== null && langSmithKey.length > 0,
        savedModelId: modelId !== null,
        savedProvider: process.env[OPENWIKI_PROVIDER_ENV_KEY] !== provider,
        shouldContinueToRun: runIngestionNow,
      });
    }
  }

  async function saveSelectedSourceDescription(description: string) {
    const connectorConfig =
      selectedSourceId === "web-search" || selectedSourceId === "hackernews"
        ? getStaticSourceConfig(selectedSourceId, description)
        : sourceState.connectorConfig;

    const sourceInstanceId = createSourceInstanceId(
      selectedSourceId,
      onboardingConfig,
    );
    const sourceInstance = {
      connectedAt: new Date().toISOString(),
      connectorConfig,
      connectorId: selectedSourceId,
      id: sourceInstanceId,
      ingestionGoal: description.length > 0 ? description : undefined,
      name: createSourceInstanceName(
        selectedSource,
        description,
        onboardingConfig,
      ),
    };
    const nextConfig = addSourceInstanceConfig(
      onboardingConfig,
      sourceInstance,
    );
    await saveConfig(nextConfig);
    setSourceState((state) => ({
      ...state,
      connectorConfig,
    }));
    setInput("");
    returnToSourceMenu();
  }

  type CompleteSetupOptions = {
    nextApiKey: string | null;
    nextBaseUrl: string | null;
    nextLangSmithKey: string | null;
    nextModelId: string | null;
    nextOAuthTokens?: CodexTokens | null;
    nextProvider: OpenWikiProvider;
    runMode: OpenWikiRunMode;
  };

  async function continueAfterCredentials(options: CompleteSetupOptions) {
    await saveCredentialUpdates(options);

    if (options.runMode === "code" && !isOnboardingComplete(onboardingConfig)) {
      setCodeRepoRoot(getDefaultCodeRepoRootPath());
      setCodeRepoSelectionIndex(0);
      setStep("code-repo-confirm");
      return;
    }

    if (!getConfigModeId(onboardingConfig)) {
      setStep("template");
      return;
    }

    if (!onboardingConfig.wikiGoal) {
      setInput(getTemplateGoal(getConfigModeId(onboardingConfig)));
      setStep("wiki-goal");
      return;
    }

    if (!onboardingConfig.ingestionSchedule) {
      setCronModeSelectionIndex(0);
      setStep("global-cron-mode");
      return;
    }

    if (!isOnboardingComplete(onboardingConfig)) {
      setStep("source-menu");
      return;
    }

    await completeSetup(options);
  }

  function continueAfterCodeRepoConfirmed(repoRoot: string) {
    if (!onboardingConfig.wikiGoal) {
      setInput(getTemplateGoal(getConfigModeId(onboardingConfig)));
      setStep("wiki-goal");
      return;
    }

    setCodeRepoRoot(repoRoot);
    setStep("final");
  }

  async function completeSetup(options: CompleteSetupOptions) {
    await saveCredentialUpdates(options);

    onComplete({
      modelId:
        options.nextModelId ??
        modelIdOverride ??
        process.env[OPENWIKI_MODEL_ID_ENV_KEY] ??
        null,
      onboardingCompleted: isOnboardingComplete(onboardingConfig),
      provider: options.nextProvider,
      repoRoot:
        options.runMode === "code" && codeRepoConfirmed
          ? codeRepoRoot
          : undefined,
      mode: options.runMode,
      runIngestionNow: false,
      savedApiKey:
        options.nextApiKey !== null || options.nextOAuthTokens != null,
      savedBaseUrl: options.nextBaseUrl !== null,
      savedLangSmithKey:
        options.nextLangSmithKey !== null &&
        options.nextLangSmithKey.length > 0,
      savedModelId: options.nextModelId !== null,
      savedProvider:
        process.env[OPENWIKI_PROVIDER_ENV_KEY] !== options.nextProvider,
      shouldContinueToRun: true,
    });
  }

  async function saveCredentialUpdates({
    nextApiKey,
    nextBaseUrl,
    nextLangSmithKey,
    nextModelId,
    nextOAuthTokens = oauthTokens,
    nextProvider,
  }: CompleteSetupOptions) {
    setIsSaving(true);

    try {
      const updates: Record<string, string> = {};

      if (process.env[OPENWIKI_PROVIDER_ENV_KEY] !== nextProvider) {
        updates[OPENWIKI_PROVIDER_ENV_KEY] = nextProvider;
      }

      if (nextApiKey !== null) {
        updates[getProviderApiKeyEnvKey(nextProvider)] = nextApiKey;
      }

      if (nextOAuthTokens) {
        Object.assign(updates, codexTokensToEnv(nextOAuthTokens));
      }

      if (nextBaseUrl !== null) {
        const baseUrlEnvKey = getProviderBaseUrlEnvKey(nextProvider);

        if (baseUrlEnvKey) {
          updates[baseUrlEnvKey] = nextBaseUrl;
        }
      }

      if (nextModelId !== null) {
        updates[OPENWIKI_MODEL_ID_ENV_KEY] = nextModelId;
      }

      if (nextLangSmithKey !== null) {
        updates.LANGSMITH_API_KEY = nextLangSmithKey;

        if (nextLangSmithKey.length > 0) {
          updates.LANGCHAIN_PROJECT = "openwiki";
          updates.LANGCHAIN_TRACING_V2 = "true";
        } else {
          // Blank input must act as an off switch: without this, a
          // LANGCHAIN_TRACING_V2=true saved by an earlier setup stays in
          // ~/.openwiki/.env and tracing silently remains enabled.
          updates.LANGCHAIN_TRACING_V2 = "false";
        }
      }

      if (Object.keys(updates).length > 0) {
        await saveOpenWikiEnv(updates);
      }
    } catch (saveError) {
      onError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function authorizeSelectedSource() {
    setIsAuthRunning(true);
    setError(null);
    setNotice(null);

    try {
      if (selectedSource.id === "git-repo") {
        await configureLocalGitRepo();
      } else if (selectedSource.authProvider) {
        const authResult = await runOAuthAuth(selectedSource.authProvider, {
          onAuthorizationUrl: ({ copiedToClipboard, openedBrowser, url }) => {
            setSourceState((state) => ({
              ...state,
              authUrl: url,
              copiedAuthUrlToClipboard: copiedToClipboard,
            }));
            setNotice(
              openedBrowser
                ? "Opened browser for authorization. Complete the flow to continue."
                : copiedToClipboard
                  ? "Open the authorization URL from your clipboard to continue."
                  : "Open the authorization URL below to continue.",
            );
          },
          silent: true,
        });
        await configureAuthProvider(authResult.provider, { force: false });
      }

      setInput("");
      setStep("source-description");
    } catch (authError) {
      setError(getErrorMessage(authError));
    } finally {
      setIsAuthRunning(false);
    }
  }

  function continueAfterSourceCredentialSetup(source: SourceSetupOption) {
    if (source.authProvider) {
      setStep("source-auth");
      return;
    }

    try {
      if (source.id === "git-repo") {
        setInput(getDefaultLocalGitRepoPath());
        setStep("source-path");
        return;
      } else if (source.id === "web-search" || source.id === "hackernews") {
        setSourceState((state) => ({
          ...state,
          connectorConfig: getStaticSourceConfig(source.id, ""),
        }));
      }

      setStep("source-description");
    } catch (setupError) {
      setError(getErrorMessage(setupError));
    }
  }

  function returnToSourceMenu() {
    setSourceSelectionIndex(activeSourceOptions.length);
    setSourceState({ secretValues: {} });
    setInput("");
    setStep("source-menu");
  }

  async function configureLocalGitRepo(
    repoPathInput = getDefaultLocalGitRepoPath(),
  ): Promise<Record<string, unknown>> {
    const sourceId = "git-repo";
    const repoPath = normalizeLocalPath(repoPathInput);
    const repoId = sanitizeRepoId(path.basename(repoPath) || "repo");
    const configPath = getConnectorConfigPath(sourceId);
    const connectorConfig = {
      repos: [
        {
          id: repoId,
          path: repoPath,
        },
      ],
    };
    await import("node:fs/promises").then(
      async ({ chmod, mkdir, stat, writeFile }) => {
        const repoStat = await stat(repoPath);
        if (!repoStat.isDirectory()) {
          throw new Error(`${repoPath} is not a directory.`);
        }

        await mkdir(path.dirname(configPath), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          configPath,
          `${JSON.stringify(connectorConfig, null, 2)}\n`,
          {
            encoding: "utf8",
            mode: 0o600,
          },
        );
        await chmod(configPath, 0o600);
      },
    );
    return connectorConfig;
  }

  async function saveModeSchedule(cronExpression: string) {
    setIsSaving(true);

    try {
      const result = await installConnectorSchedule({
        connectorId: "git-repo",
        cronExpression,
        cwd: process.cwd(),
      });
      const nextConfig: OpenWikiOnboardingConfig = {
        ...onboardingConfig,
        ingestionSchedule: {
          description: result.description,
          expression: result.expression,
          launchAgentPath: result.launchAgentPath,
          updatedAt: new Date().toISOString(),
          warning: result.warning,
        },
      };
      await saveConfig(nextConfig);
      setSourceState((state) => ({
        ...state,
        savedScheduleWarning: result.warning,
      }));
      setPowerModeSelectionIndex(0);
      setStep("global-power-mode");
    } catch (scheduleError) {
      setError(getErrorMessage(scheduleError));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveGlobalMacPowerWindow() {
    setIsSaving(true);

    try {
      const configForPower = await readOpenWikiOnboardingConfig();
      const result = await installOpenWikiPowerSchedule(configForPower);
      const nextConfig: OpenWikiOnboardingConfig = {
        ...configForPower,
        powerManagement: {
          ...configForPower.powerManagement,
          pmset: {
            days: result.days,
            enabled: result.enabled,
            sleepTime: result.sleepTime,
            updatedAt: new Date().toISOString(),
            wakeTime: result.wakeTime,
            warning: result.warning,
          },
        },
      };
      await saveConfig(nextConfig);
      setSourceSelectionIndex(0);
      setSourceState({
        secretValues: {},
        savedScheduleWarning: result.warning,
      });
      setInput("");
      setStep("source-menu");
    } catch (powerError) {
      setError(getErrorMessage(powerError));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveConfig(config: OpenWikiOnboardingConfig) {
    setIsSaving(true);
    try {
      await saveOpenWikiOnboardingConfig(config);
      setOnboardingConfig(config);
    } catch (saveError) {
      onError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function saveConfigForCurrentMode(config: OpenWikiOnboardingConfig) {
    if (!isCodeMode(config)) {
      await saveConfig(config);
      return;
    }

    setIsSaving(true);
    try {
      if (config.wikiGoal?.trim()) {
        await saveRepositoryWikiInstructions(codeRepoRoot, config.wikiGoal);
      }
      await saveOpenWikiOnboardingConfig({
        ...config,
        wikiGoal: undefined,
      });
      setOnboardingConfig(config);
    } catch (saveError) {
      onError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  function submitManualLogin(pasted: string): void {
    const handle = loginHandleRef.current;

    if (!handle) {
      setError("Login is still starting. Try again in a moment.");
      return;
    }

    const errorMessage = handle.submitManual(pasted);

    if (errorMessage) {
      setError(errorMessage);
      return;
    }

    setInput("");
    setError(null);
  }

  const needsCredentialPrompt =
    !hasValidConfiguredProvider() ||
    needsCredentialStep(provider) ||
    needsBaseUrlStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    process.env.LANGSMITH_API_KEY === undefined;

  return (
    <Box flexDirection="column">
      <SetupHeader />

      <Box flexDirection="column" marginBottom={1}>
        <SetupStep
          label="Provider"
          state={
            hasValidConfiguredProvider()
              ? "done"
              : step === "provider"
                ? "current"
                : "pending"
          }
          detail={getProviderSetupDetail(provider)}
        />
        <SetupStep
          label={providerUsesOAuth(provider) ? "ChatGPT login" : "Provider key"}
          state={
            isCredentialConfigured(provider) || oauthTokens
              ? "done"
              : step === credentialStep(provider)
                ? "current"
                : "pending"
          }
          detail={getCredentialSetupDetail(provider, oauthTokens)}
        />
        {providerRequiresBaseUrl(provider) ? (
          <SetupStep
            label="Base URL"
            state={
              isBaseUrlConfigured(provider)
                ? "done"
                : step === "base-url"
                  ? "current"
                  : "pending"
            }
            detail={
              isBaseUrlConfigured(provider)
                ? "available from environment"
                : `save ${getProviderBaseUrlEnvKey(provider)} to ${openWikiEnvPath}`
            }
          />
        ) : null}
        <SetupStep
          label="Model"
          state={
            modelIdOverride || process.env[OPENWIKI_MODEL_ID_ENV_KEY]
              ? "done"
              : step === "model"
                ? "current"
                : "pending"
          }
          detail={getModelSetupDetail(modelIdOverride, provider)}
        />
        <SetupStep
          label="LangSmith"
          state={
            process.env.LANGSMITH_API_KEY !== undefined
              ? "done"
              : step === "langsmith"
                ? "current"
                : "optional"
          }
          detail={
            process.env.LANGSMITH_API_KEY !== undefined
              ? "available from environment"
              : "optional tracing key"
          }
        />
        <SetupStep
          label="Run mode"
          state={
            allowModeSelection
              ? step === "run-mode"
                ? "current"
                : "done"
              : "done"
          }
          detail={getRunModeName(selectedMode)}
        />
        {selectedMode === "personal" ? (
          <SetupStep
            label="Personal profile"
            state={
              onboardingConfig.templateId
                ? "done"
                : step === "template"
                  ? "current"
                  : "pending"
            }
            detail={getConfigModeName(onboardingConfig) ?? "choose a profile"}
          />
        ) : null}
        <SetupStep
          label="Wiki scope"
          state={
            selectedMode === "code"
              ? "done"
              : onboardingConfig.wikiGoal
                ? "done"
                : step === "wiki-goal"
                  ? "current"
                  : "pending"
          }
          detail={
            selectedMode === "code"
              ? "repository openwiki/"
              : onboardingConfig.wikiGoal
                ? "saved"
                : `save onboarding profile to ${openWikiOnboardingPath}`
          }
        />
        {selectedMode === "personal" ? (
          <SetupStep
            label="Schedule"
            state={
              onboardingConfig.ingestionSchedule
                ? "done"
                : isScheduleStep(step)
                  ? "current"
                  : "pending"
            }
            detail={
              onboardingConfig.ingestionSchedule
                ? onboardingConfig.ingestionSchedule.description
                : "choose one time for all ingestion"
            }
          />
        ) : null}
        {selectedMode === "personal" ? (
          <SetupStep
            label="Sources"
            state={
              getConnectedSourceCount(onboardingConfig, activeSourceOptions) > 0
                ? "done"
                : isSourceStep(step)
                  ? "current"
                  : "pending"
            }
            detail={`${getConnectedSourceCount(
              onboardingConfig,
              activeSourceOptions,
            )} setup(s) configured`}
          />
        ) : null}
      </Box>

      {step === "oauth-login" ? (
        <OAuthLoginPrompt
          copied={copied}
          input={input}
          isLoggingIn={isLoggingIn}
          loginUrl={loginUrl}
          provider={provider}
        />
      ) : (
        <SetupPanel title="Prompt">
          {step ? (
            <Prompt
              codeRepoRoot={codeRepoRoot}
              codeRepoSelectionIndex={codeRepoSelectionIndex}
              cronFieldSelectionIndex={cronFieldSelectionIndex}
              cronModeSelectionIndex={cronModeSelectionIndex}
              finalSelectionIndex={finalSelectionIndex}
              input={input}
              inputDisplayWidth={inputDisplayWidth}
              isCustomModelInput={isCustomModelInput}
              modelSelectionIndex={modelSelectionIndex}
              onboardingConfig={onboardingConfig}
              powerModeSelectionIndex={powerModeSelectionIndex}
              provider={provider}
              providerSelectionIndex={providerSelectionIndex}
              runModeSelectionIndex={runModeSelectionIndex}
              secretInputIndex={secretInputIndex}
              selectedMode={selectedMode}
              selectedSource={selectedSource}
              sourceOptions={activeSourceOptions}
              sourceContinueSelectionIndex={sourceContinueSelectionIndex}
              sourceDescriptionSelectionIndex={sourceDescriptionSelectionIndex}
              sourceSelectionIndex={sourceSelectionIndex}
              sourceState={sourceState}
              step={step}
              suggestedCronDescription={suggestedCronDescription}
              suggestedCronExpression={suggestedCronExpression}
              templateSelectionIndex={templateSelectionIndex}
            />
          ) : (
            <Text>Inspecting OpenWiki setup...</Text>
          )}
        </SetupPanel>
      )}

      {needsCredentialPrompt ? (
        <Text color="gray">Secrets are masked and saved only after setup.</Text>
      ) : null}
      {notice ? (
        <SetupPanel title="Status">
          <Text color="cyan">{notice}</Text>
        </SetupPanel>
      ) : null}
      {error ? (
        <SetupPanel title="Error">
          <Text color="red">{error}</Text>
        </SetupPanel>
      ) : null}
      {sourceState.savedScheduleWarning ? (
        <SetupPanel title="Schedule note">
          <Text color="yellow">{sourceState.savedScheduleWarning}</Text>
        </SetupPanel>
      ) : null}
      {isSaving ? (
        <SetupPanel title="Saving">
          <Text>Writing OpenWiki setup...</Text>
        </SetupPanel>
      ) : null}
      {isAuthRunning ? (
        <SetupPanel title="Authorization">
          <Text>Waiting for the browser authorization callback...</Text>
        </SetupPanel>
      ) : null}
    </Box>
  );
}

function handleCronEditorInput({
  currentFieldIndex,
  currentValue,
  fallbackExpression,
  inputValue,
  key,
  replaceCurrentField,
  setCurrentFieldIndex,
  setReplaceCurrentField,
  setValue,
}: {
  currentFieldIndex: number;
  currentValue: string;
  fallbackExpression: string;
  inputValue: string;
  key: PromptInputKey;
  replaceCurrentField: boolean;
  setCurrentFieldIndex: React.Dispatch<React.SetStateAction<number>>;
  setReplaceCurrentField: React.Dispatch<React.SetStateAction<boolean>>;
  setValue: React.Dispatch<React.SetStateAction<string>>;
}): boolean {
  if (key.leftArrow) {
    setCurrentFieldIndex((index) => Math.max(0, index - 1));
    setReplaceCurrentField(true);
    return true;
  }

  if (key.rightArrow || key.tab || inputValue === " " || inputValue === "\t") {
    setCurrentFieldIndex((index) =>
      Math.min(CRON_FIELD_LABELS.length - 1, index + 1),
    );
    setReplaceCurrentField(true);
    return true;
  }

  if (key.backspace || key.delete) {
    const fields = getCronFields(currentValue, fallbackExpression);
    const currentField = fields[currentFieldIndex] ?? "";
    if (currentField.length === 0 && currentFieldIndex > 0) {
      setCurrentFieldIndex(currentFieldIndex - 1);
      setReplaceCurrentField(false);
      return true;
    }

    fields[currentFieldIndex] = currentField.slice(0, -1);
    setValue(fields.join(" "));
    setReplaceCurrentField(false);
    return true;
  }

  if (key.ctrl || key.meta) {
    return false;
  }

  const pastedFields = parseCronFieldPaste(inputValue);
  if (pastedFields.length > 1) {
    const fields = getCronFields(currentValue, fallbackExpression);
    pastedFields.forEach((field, offset) => {
      const fieldIndex = currentFieldIndex + offset;
      if (fieldIndex < CRON_FIELD_LABELS.length) {
        fields[fieldIndex] = field;
      }
    });
    setValue(fields.join(" "));
    setCurrentFieldIndex((index) =>
      Math.min(CRON_FIELD_LABELS.length - 1, index + pastedFields.length - 1),
    );
    setReplaceCurrentField(true);
    return true;
  }

  const sanitizedInput = sanitizeCronInputChunk(inputValue);

  if (!sanitizedInput) {
    return false;
  }

  const fields = getCronFields(currentValue, fallbackExpression);
  fields[currentFieldIndex] = replaceCurrentField
    ? sanitizedInput
    : `${fields[currentFieldIndex] ?? ""}${sanitizedInput}`;
  setValue(fields.join(" "));
  setReplaceCurrentField(false);
  return true;
}
