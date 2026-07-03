import { existsSync, readFileSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureOpenWikiHome, openWikiHomeDir } from "./openwiki-home.js";
import type { ConnectorId } from "./connectors/types.js";

export const openWikiOnboardingPath = path.join(
  openWikiHomeDir,
  "onboarding.json",
);

export type OnboardingSourceConfig = {
  connectedAt?: string;
  ingestionGoal?: string;
  schedule?: {
    description: string;
    expression: string;
    launchAgentPath?: string;
    pausedAt?: string;
    updatedAt: string;
    warning?: string;
  };
};

export type OpenWikiPowerManagementConfig = {
  pmset?: {
    days: string;
    enabled: boolean;
    sleepTime: string;
    updatedAt: string;
    wakeTime: string;
    warning?: string;
  };
};

export type OpenWikiOnboardingConfig = {
  completedAt?: string;
  powerManagement?: OpenWikiPowerManagementConfig;
  sources: Partial<Record<ConnectorId, OnboardingSourceConfig>>;
  templateId?: string;
  templateName?: string;
  version: 1;
  wikiGoal?: string;
};

export function createEmptyOnboardingConfig(): OpenWikiOnboardingConfig {
  return {
    sources: {},
    version: 1,
  };
}

export async function readOpenWikiOnboardingConfig(): Promise<OpenWikiOnboardingConfig> {
  await ensureOpenWikiHome();

  try {
    return normalizeOnboardingConfig(
      JSON.parse(await readFile(openWikiOnboardingPath, "utf8")),
    );
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return createEmptyOnboardingConfig();
    }

    throw error;
  }
}

export async function saveOpenWikiOnboardingConfig(
  config: OpenWikiOnboardingConfig,
): Promise<void> {
  await ensureOpenWikiHome();
  await writeFile(
    openWikiOnboardingPath,
    `${JSON.stringify(normalizeOnboardingConfig(config), null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await chmod(openWikiOnboardingPath, 0o600);
}

export function isOnboardingComplete(
  config: OpenWikiOnboardingConfig,
): boolean {
  return Boolean(config.completedAt && config.wikiGoal);
}

export function isOpenWikiOnboardingCompleteSync(): boolean {
  if (!existsSync(openWikiOnboardingPath)) {
    return false;
  }

  try {
    return isOnboardingComplete(
      normalizeOnboardingConfig(
        JSON.parse(readFileSync(openWikiOnboardingPath, "utf8")),
      ),
    );
  } catch {
    return false;
  }
}

function normalizeOnboardingConfig(value: unknown): OpenWikiOnboardingConfig {
  if (!isObject(value)) {
    return createEmptyOnboardingConfig();
  }

  const sources = isObject(value.sources) ? value.sources : {};
  const config: OpenWikiOnboardingConfig = {
    sources: {},
    version: 1,
  };

  if (typeof value.completedAt === "string") {
    config.completedAt = value.completedAt;
  }

  if (typeof value.wikiGoal === "string") {
    config.wikiGoal = value.wikiGoal;
  }

  if (typeof value.templateId === "string") {
    config.templateId = value.templateId;
  }

  if (typeof value.templateName === "string") {
    config.templateName = value.templateName;
  }

  if (isObject(value.powerManagement)) {
    config.powerManagement = normalizePowerManagementConfig(
      value.powerManagement,
    );
  }

  for (const [sourceId, sourceValue] of Object.entries(sources)) {
    if (!isKnownConnectorId(sourceId) || !isObject(sourceValue)) {
      continue;
    }

    config.sources[sourceId] = {
      connectedAt:
        typeof sourceValue.connectedAt === "string"
          ? sourceValue.connectedAt
          : undefined,
      ingestionGoal:
        typeof sourceValue.ingestionGoal === "string"
          ? sourceValue.ingestionGoal
          : undefined,
      schedule: isObject(sourceValue.schedule)
        ? {
            description:
              typeof sourceValue.schedule.description === "string"
                ? sourceValue.schedule.description
                : "",
            expression:
              typeof sourceValue.schedule.expression === "string"
                ? sourceValue.schedule.expression
                : "",
            launchAgentPath:
              typeof sourceValue.schedule.launchAgentPath === "string"
                ? sourceValue.schedule.launchAgentPath
                : undefined,
            pausedAt:
              typeof sourceValue.schedule.pausedAt === "string"
                ? sourceValue.schedule.pausedAt
                : undefined,
            updatedAt:
              typeof sourceValue.schedule.updatedAt === "string"
                ? sourceValue.schedule.updatedAt
                : new Date(0).toISOString(),
            warning:
              typeof sourceValue.schedule.warning === "string"
                ? sourceValue.schedule.warning
                : undefined,
          }
        : undefined,
    };
  }

  return config;
}

function normalizePowerManagementConfig(
  value: Record<string, unknown>,
): OpenWikiPowerManagementConfig | undefined {
  if (!isObject(value.pmset)) {
    return undefined;
  }

  return {
    pmset: {
      days: typeof value.pmset.days === "string" ? value.pmset.days : "",
      enabled:
        typeof value.pmset.enabled === "boolean" ? value.pmset.enabled : false,
      sleepTime:
        typeof value.pmset.sleepTime === "string" ? value.pmset.sleepTime : "",
      updatedAt:
        typeof value.pmset.updatedAt === "string"
          ? value.pmset.updatedAt
          : new Date(0).toISOString(),
      wakeTime:
        typeof value.pmset.wakeTime === "string" ? value.pmset.wakeTime : "",
      warning:
        typeof value.pmset.warning === "string"
          ? value.pmset.warning
          : undefined,
    },
  };
}

function isKnownConnectorId(value: string): value is ConnectorId {
  return (
    value === "git-repo" ||
    value === "google" ||
    value === "hackernews" ||
    value === "notion" ||
    value === "slack" ||
    value === "web-search" ||
    value === "x"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
