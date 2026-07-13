import { existsSync } from "node:fs";
import path from "node:path";
import {
  formatChatGptAccount,
  isChatGptTokenExpired,
  readCodexTokensFromEnv,
  type CodexTokens,
} from "../agent/openai-chatgpt-oauth.js";
import type { OpenWikiRunMode } from "../cli/parse.js";
import {
  OPENAI_CHATGPT_EMAIL_ENV_KEY,
  OPENAI_CHATGPT_PLAN_ENV_KEY,
  OPENWIKI_MODEL_ID_ENV_KEY,
  OPENWIKI_PROVIDER_ENV_KEY,
} from "../constants.js";
import { openWikiEnvPath } from "../env.js";
import {
  createEmptyOnboardingConfig,
  isOnboardingComplete,
  isOpenWikiOnboardingCompleteSync,
  isRepositoryCodeOnboardingCompleteSync,
  type OpenWikiOnboardingConfig,
} from "../onboarding.js";
import { getConfigModeId, isCodeMode } from "../onboarding-setup.js";
import {
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  normalizeProvider,
  providerRequiresBaseUrl,
  providerUsesOAuth,
  resolveConfiguredProvider,
  type OpenWikiProvider,
} from "../providers/config.js";

/**
 * True when interactive credential/onboarding setup is required before a run:
 * the provider lacks a usable credential or required base URL, no model id is
 * configured, LangSmith is unset, or the mode's onboarding is incomplete.
 */
export function needsCredentialSetup(
  modelIdOverride: string | null = null,
  mode: OpenWikiRunMode = "personal",
): boolean {
  const provider = resolveConfiguredProvider();

  const needsCredentials =
    !hasValidConfiguredProvider() ||
    needsCredentialStep(provider) ||
    needsBaseUrlStep(provider) ||
    (modelIdOverride === null &&
      process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined) ||
    process.env.LANGSMITH_API_KEY === undefined;

  if (needsCredentials) {
    return true;
  }

  return mode === "code"
    ? !isRepositoryCodeOnboardingCompleteSync(getDefaultCodeRepoRootPath())
    : !isOpenWikiOnboardingCompleteSync();
}

/**
 * Whether the provider still needs its primary credential collected. For
 * `oauth` providers this is a valid, non-expired stored token; for everyone
 * else it is a pasted API key.
 */
export function needsCredentialStep(provider: OpenWikiProvider): boolean {
  return providerUsesOAuth(provider)
    ? !hasValidStoredToken()
    : !process.env[getProviderApiKeyEnvKey(provider)];
}

/**
 * True when a non-expired ChatGPT OAuth token is stored in the environment.
 */
function hasValidStoredToken(env: NodeJS.ProcessEnv = process.env): boolean {
  const tokens = readCodexTokensFromEnv(env);

  return tokens !== null && !isChatGptTokenExpired(tokens.expiresAtMs);
}

/**
 * True when the provider requires a base URL that is not yet configured.
 */
export function needsBaseUrlStep(provider: OpenWikiProvider): boolean {
  if (!providerRequiresBaseUrl(provider)) {
    return false;
  }

  return !isBaseUrlConfigured(provider);
}

/**
 * True when the provider's base-URL env var is set.
 */
export function isBaseUrlConfigured(provider: OpenWikiProvider): boolean {
  const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider);

  return baseUrlEnvKey ? Boolean(process.env[baseUrlEnvKey]) : false;
}

/**
 * True when the provider's credential is present: an API key, or a valid,
 * non-expired OAuth token for OAuth providers.
 */
export function isCredentialConfigured(provider: OpenWikiProvider): boolean {
  return providerUsesOAuth(provider)
    ? hasValidStoredToken()
    : Boolean(process.env[getProviderApiKeyEnvKey(provider)]);
}

/**
 * Human-readable status of the provider's credential for the setup summary
 * (e.g. "available from environment", "signed in as …", or where to save a key).
 */
export function getCredentialSetupDetail(
  provider: OpenWikiProvider,
  tokens: CodexTokens | null = null,
): string {
  if (providerUsesOAuth(provider)) {
    if (!isCredentialConfigured(provider) && !tokens) {
      return "sign in with your ChatGPT account";
    }

    const account = formatChatGptAccount(
      tokens?.email ?? process.env[OPENAI_CHATGPT_EMAIL_ENV_KEY] ?? null,
      tokens?.planType ?? process.env[OPENAI_CHATGPT_PLAN_ENV_KEY] ?? null,
    );

    return account ? `signed in as ${account}` : "signed in with ChatGPT";
  }

  return isCredentialConfigured(provider)
    ? "available from environment"
    : `save ${getProviderApiKeyEnvKey(provider)} to ${openWikiEnvPath}`;
}

/**
 * True when `OPENWIKI_PROVIDER` names a recognized provider.
 */
export function hasValidConfiguredProvider(): boolean {
  return normalizeProvider(process.env[OPENWIKI_PROVIDER_ENV_KEY]) !== null;
}

/**
 * The default path for a local git-repo source: the current working directory.
 */
export function getDefaultLocalGitRepoPath(): string {
  return process.cwd();
}

/**
 * The repository root for code mode: the nearest ancestor containing `.git`,
 * falling back to the current working directory.
 */
export function getDefaultCodeRepoRootPath(): string {
  return findNearestGitRepoRoot(process.cwd()) ?? process.cwd();
}

/**
 * Walks up from `startPath` to the nearest directory containing a `.git` entry,
 * or `null` if the filesystem root is reached without finding one.
 */
export function findNearestGitRepoRoot(startPath: string): string | null {
  let currentPath = path.resolve(startPath);

  while (true) {
    if (existsSync(path.join(currentPath, ".git"))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }

    currentPath = parentPath;
  }
}

/**
 * The identifier of one prompt in the interactive setup wizard. The step machine
 * (`getInitialStep` / `getNextStepAfter*`) returns these to tell the UI which
 * prompt to render next; the machine returns `null` when setup is complete.
 */
export type PromptStep =
  | "api-key"
  | "base-url"
  | "code-repo-confirm"
  | "code-repo-path"
  | "final"
  | "langsmith"
  | "model"
  | "oauth-login"
  | "provider"
  | "run-mode"
  | "source-auth"
  | "global-cron-custom"
  | "global-cron-mode"
  | "global-power-mode"
  | "source-description"
  | "source-description-custom"
  | "source-menu"
  | "source-path"
  | "source-confirm-continue"
  | "source-secret"
  | "template"
  | "wiki-goal";

/**
 * The step that collects a provider's primary credential: the ChatGPT OAuth
 * login for OAuth providers, or a pasted API key for everyone else.
 */
export function credentialStep(provider: OpenWikiProvider): PromptStep {
  return providerUsesOAuth(provider) ? "oauth-login" : "api-key";
}

/**
 * The first wizard step to show when setup opens: the earliest prerequisite that
 * is not yet satisfied (provider, credential, base URL, model, LangSmith, then
 * mode-specific onboarding), or `null` when nothing needs collecting.
 */
export function getInitialStep(
  modelIdOverride: string | null,
  provider: OpenWikiProvider,
  onboardingConfig: OpenWikiOnboardingConfig = createEmptyOnboardingConfig(),
  mode: OpenWikiRunMode = "code",
  allowModeSelection = false,
): PromptStep | null {
  if (allowModeSelection) {
    return "run-mode";
  }

  if (!hasValidConfiguredProvider()) {
    return "provider";
  }

  if (needsCredentialStep(provider)) {
    return credentialStep(provider);
  }

  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  if (
    modelIdOverride === null &&
    process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined
  ) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  if (mode === "code" && !isOnboardingComplete(onboardingConfig)) {
    return "code-repo-confirm";
  }

  if (!getConfigModeId(onboardingConfig)) {
    return "template";
  }

  if (!onboardingConfig.wikiGoal) {
    return "wiki-goal";
  }

  if (!isCodeMode(onboardingConfig) && !onboardingConfig.ingestionSchedule) {
    return "global-cron-mode";
  }

  if (!isOnboardingComplete(onboardingConfig)) {
    return "source-menu";
  }

  return null;
}

/**
 * The step to advance to after a provider is chosen: the provider's own
 * credential step if one is still needed, otherwise the same downstream routing
 * as `getNextStepAfterApiKey`.
 */
export function getNextStepAfterProvider(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig = createEmptyOnboardingConfig(),
  mode: OpenWikiRunMode = "code",
  forceModelStep = false,
): PromptStep | null {
  if (needsCredentialStep(provider)) {
    return credentialStep(provider);
  }

  return getNextStepAfterApiKey(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

/**
 * The step to advance to after a credential is collected: the base-URL step if
 * the provider requires one, otherwise the same downstream routing as
 * `getNextStepAfterBaseUrl`.
 */
export function getNextStepAfterApiKey(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (needsBaseUrlStep(provider)) {
    return "base-url";
  }

  return getNextStepAfterBaseUrl(
    provider,
    modelIdOverride,
    onboardingConfig,
    mode,
    forceModelStep,
  );
}

/**
 * The step to advance to once provider, credential, and base URL are settled:
 * the earliest remaining prerequisite (model, LangSmith, then mode-specific
 * onboarding), or `null` when setup is complete. `forceModelStep` re-asks the
 * model even when one is stored, used after a provider change.
 */
export function getNextStepAfterBaseUrl(
  provider: OpenWikiProvider,
  modelIdOverride: string | null,
  onboardingConfig: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  forceModelStep = false,
): PromptStep | null {
  if (
    modelIdOverride === null &&
    (forceModelStep || process.env[OPENWIKI_MODEL_ID_ENV_KEY] === undefined)
  ) {
    return "model";
  }

  if (process.env.LANGSMITH_API_KEY === undefined) {
    return "langsmith";
  }

  if (mode === "code" && !isOnboardingComplete(onboardingConfig)) {
    return "code-repo-confirm";
  }

  if (!getConfigModeId(onboardingConfig)) {
    return "template";
  }

  if (!onboardingConfig.wikiGoal) {
    return "wiki-goal";
  }

  if (!isCodeMode(onboardingConfig) && !onboardingConfig.ingestionSchedule) {
    return "global-cron-mode";
  }

  if (!isOnboardingComplete(onboardingConfig)) {
    return "source-menu";
  }

  return null;
}
