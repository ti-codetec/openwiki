import { access, chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureOpenWikiHome, openWikiHomeDir } from "../openwiki-home.js";
import type { ConnectorId } from "../connectors/types.js";
import type { OpenWikiOnboardingConfig } from "../onboarding/store.js";
import {
  getSingleCronNumber,
  parseSimpleCronFields,
  validateCronExpression,
} from "./cron.js";
import {
  type PowerScheduleInstallResult,
  reconcileOpenWikiPowerSchedule,
} from "./power.js";

const execFileAsync = promisify(execFile);

/**
 * The result of installing a connector ingestion schedule.
 */
export interface ScheduleInstallResult {
  /**
   * Human description of the installed cron schedule.
   */
  description: string;

  /**
   * The normalized cron expression that was installed.
   */
  expression: string;

  /**
   * Path to the launchd plist that was written; absent on non-macOS platforms
   * where native installation is skipped.
   */
  launchAgentPath?: string;

  /**
   * A note when the schedule was saved but not natively installed; absent when
   * installation fully succeeded.
   */
  warning?: string;
}

/**
 * The current status of a saved connector schedule, including whether its
 * launchd agent is present and loaded.
 */
export interface ConnectorScheduleStatus {
  /**
   * The connector this schedule ingests, when scoped to one; absent for the
   * combined "all" schedule.
   */
  connectorId?: ConnectorId;

  /**
   * Human description of the cron schedule.
   */
  description: string;

  /**
   * Display name shown for the schedule; absent when unnamed.
   */
  displayName?: string;

  /**
   * The cron expression the schedule runs on.
   */
  expression: string;

  /**
   * Whether the launchd agent is currently loaded (running).
   */
  launchAgentLoaded: boolean;

  /**
   * Path to the launchd plist; absent when none was written.
   */
  launchAgentPath?: string;

  /**
   * Whether the launchd plist file exists on disk.
   */
  launchAgentPlistExists: boolean;

  /**
   * ISO timestamp of when the schedule was paused; absent when active.
   */
  pausedAt?: string;

  /**
   * The source instance the schedule belongs to (`all` for the combined one).
   */
  sourceInstanceId: string;

  /**
   * ISO timestamp of when the schedule was last updated.
   */
  updatedAt: string;

  /**
   * A note about a partial or skipped install; absent when there is none.
   */
  warning?: string;
}

/**
 * The outcome of mutating schedules (pause/resume/delete): the updated config
 * plus which connectors changed, which were skipped, and any warnings.
 */
export interface ScheduleMutationResult {
  /**
   * The onboarding config after the mutation.
   */
  config: OpenWikiOnboardingConfig;

  /**
   * Ids of the connectors whose schedules were changed.
   */
  connectorIds: string[];

  /**
   * The reconciled power schedule, when the mutation adjusted it.
   */
  powerSchedule?: PowerScheduleInstallResult;

  /**
   * Ids of connectors that were left unchanged (e.g. already in the target
   * state).
   */
  skippedConnectorIds: string[];

  /**
   * Human warnings gathered while applying the mutation.
   */
  warnings: string[];
}

export type ScheduleTarget = ConnectorId | "all";

type CalendarInterval = Partial<
  Record<"Hour" | "Minute" | "Month" | "Day" | "Weekday", number>
>;

/**
 * Installs a launchd agent that runs ingestion on the given cron schedule.
 * Validates the expression first, and on non-macOS platforms (or expressions
 * too complex for launchd) returns a saved-but-not-installed result.
 */
export async function installConnectorSchedule({
  connectorId,
  cronExpression,
  cwd,
}: {
  connectorId: ConnectorId;
  cronExpression: string;
  cwd: string;
}): Promise<ScheduleInstallResult> {
  const validation = validateCronExpression(cronExpression);

  if (!validation.valid) {
    throw new Error(validation.error);
  }

  if (process.platform !== "darwin") {
    return {
      description: validation.description,
      expression: validation.expression,
      warning:
        "Schedule saved, but native installation is currently macOS-only.",
    };
  }

  const calendarInterval = parseLaunchdCalendarInterval(validation.expression);
  if (!calendarInterval) {
    return {
      description: validation.description,
      expression: validation.expression,
      warning:
        "Schedule saved, but this cron expression is too complex for direct launchd installation.",
    };
  }

  void connectorId;
  const label = getLaunchAgentLabel();
  const launchAgentsDir = getLaunchAgentsDir();
  const logsDir = path.join(openWikiHomeDir, "logs");
  const plistPath = getLaunchAgentPath();

  await ensureOpenWikiHome();
  await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
  await mkdir(logsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    plistPath,
    createLaunchAgentPlist({
      calendarInterval,
      cwd,
      label,
      logPath: path.join(logsDir, "ingestion.schedule.log"),
    }),
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await chmod(plistPath, 0o600);

  await unloadLaunchAgent();
  const launchdDomain = getLaunchdDomain();
  await execFileAsync("launchctl", ["bootstrap", launchdDomain, plistPath]);

  return {
    description: validation.description,
    expression: validation.expression,
    launchAgentPath: plistPath,
  };
}

/**
 * Lists the current ingestion schedules with their launchd load/existence
 * status; empty when none is configured.
 */
export async function listConnectorSchedules(
  config: OpenWikiOnboardingConfig,
): Promise<ConnectorScheduleStatus[]> {
  const schedule = config.ingestionSchedule;
  if (!schedule) {
    return [];
  }

  const launchAgentPath = schedule.launchAgentPath;
  return [
    {
      description: schedule.description,
      displayName: "All ingestion",
      expression: schedule.expression,
      launchAgentLoaded: schedule.pausedAt
        ? false
        : await isLaunchAgentLoaded(),
      launchAgentPath,
      launchAgentPlistExists: launchAgentPath
        ? await pathExists(launchAgentPath)
        : false,
      pausedAt: schedule.pausedAt,
      sourceInstanceId: "all",
      updatedAt: schedule.updatedAt,
      warning: schedule.warning,
    },
  ];
}

/**
 * Pauses the ingestion schedule (unloading its launchd agent) and reconciles
 * the power schedule. A no-op when there is nothing active to pause.
 */
export async function pauseConnectorSchedules(
  config: OpenWikiOnboardingConfig,
  target: ScheduleTarget,
): Promise<ScheduleMutationResult> {
  if (
    target !== "all" ||
    !config.ingestionSchedule ||
    config.ingestionSchedule.pausedAt
  ) {
    return {
      config,
      connectorIds: [],
      skippedConnectorIds: [target],
      warnings: [],
    };
  }

  let nextConfig = cloneOnboardingConfig(config);
  nextConfig = {
    ...nextConfig,
    ingestionSchedule: {
      ...config.ingestionSchedule,
      pausedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  await unloadLaunchAgent();

  const reconciled = await reconcileOpenWikiPowerSchedule(nextConfig);
  return {
    config: reconciled.config,
    connectorIds: ["all"],
    powerSchedule: reconciled.powerSchedule,
    skippedConnectorIds: [],
    warnings: reconciled.powerSchedule?.warning
      ? [reconciled.powerSchedule.warning]
      : [],
  };
}

/**
 * Resumes a paused ingestion schedule by reinstalling its launchd agent and
 * reconciling the power schedule. A no-op when there is nothing paused.
 */
export async function resumeConnectorSchedules({
  config,
  cwd,
  target,
}: {
  config: OpenWikiOnboardingConfig;
  cwd: string;
  target: ScheduleTarget;
}): Promise<ScheduleMutationResult> {
  if (
    target !== "all" ||
    !config.ingestionSchedule ||
    !config.ingestionSchedule.pausedAt
  ) {
    return {
      config,
      connectorIds: [],
      skippedConnectorIds: [target],
      warnings: [],
    };
  }

  const result = await installConnectorSchedule({
    connectorId: "git-repo",
    cronExpression: config.ingestionSchedule.expression,
    cwd,
  });
  const nextConfig = {
    ...cloneOnboardingConfig(config),
    ingestionSchedule: {
      description: result.description,
      expression: result.expression,
      launchAgentPath: result.launchAgentPath,
      updatedAt: new Date().toISOString(),
      warning: result.warning,
    },
  };

  const reconciled = await reconcileOpenWikiPowerSchedule(nextConfig);
  return {
    config: reconciled.config,
    connectorIds: ["all"],
    powerSchedule: reconciled.powerSchedule,
    skippedConnectorIds: [],
    warnings: [
      ...(result.warning ? [result.warning] : []),
      ...(reconciled.powerSchedule?.warning
        ? [reconciled.powerSchedule.warning]
        : []),
    ],
  };
}

/**
 * Deletes the ingestion schedule, removing its launchd agent and plist, and
 * reconciles the power schedule. A no-op when none is configured.
 */
export async function deleteConnectorSchedules(
  config: OpenWikiOnboardingConfig,
  target: ScheduleTarget,
): Promise<ScheduleMutationResult> {
  if (target !== "all" || !config.ingestionSchedule) {
    return {
      config,
      connectorIds: [],
      skippedConnectorIds: [target],
      warnings: [],
    };
  }

  const nextConfig = cloneOnboardingConfig(config);
  delete nextConfig.ingestionSchedule;
  await unloadLaunchAgent();
  await removeLaunchAgentPlist();

  const reconciled = await reconcileOpenWikiPowerSchedule(nextConfig);
  return {
    config: reconciled.config,
    connectorIds: ["all"],
    powerSchedule: reconciled.powerSchedule,
    skippedConnectorIds: [],
    warnings: reconciled.powerSchedule?.warning
      ? [reconciled.powerSchedule.warning]
      : [],
  };
}

function cloneOnboardingConfig(
  config: OpenWikiOnboardingConfig,
): OpenWikiOnboardingConfig {
  const sourceInstances = config.sourceInstances.map((sourceConfig) => ({
    ...sourceConfig,
    connectorConfig: sourceConfig.connectorConfig
      ? { ...sourceConfig.connectorConfig }
      : undefined,
  }));

  return {
    ...config,
    ingestionSchedule: config.ingestionSchedule
      ? { ...config.ingestionSchedule }
      : undefined,
    powerManagement: config.powerManagement
      ? {
          ...config.powerManagement,
          pmset: config.powerManagement.pmset
            ? { ...config.powerManagement.pmset }
            : undefined,
        }
      : undefined,
    sourceInstances,
    sources: deriveLegacySources(sourceInstances),
  };
}

function deriveLegacySources(
  sourceInstances: OpenWikiOnboardingConfig["sourceInstances"],
): OpenWikiOnboardingConfig["sources"] {
  const sources: OpenWikiOnboardingConfig["sources"] = {};

  for (const sourceConfig of sourceInstances) {
    if (!sources[sourceConfig.connectorId]) {
      sources[sourceConfig.connectorId] = {
        connectedAt: sourceConfig.connectedAt,
        connectorConfig: sourceConfig.connectorConfig,
        ingestionGoal: sourceConfig.ingestionGoal,
      };
    }
  }

  return sources;
}

function parseLaunchdCalendarInterval(
  expression: string,
): CalendarInterval | null {
  const parsed = parseSimpleCronFields(expression);
  if (!parsed) {
    return null;
  }

  const { day, hour, minute, month, weekday } = parsed;

  const parsedMinute = getSingleCronNumber(minute, { max: 59, min: 0 });
  if (parsedMinute === null) {
    return null;
  }

  const interval: CalendarInterval = {
    Minute: parsedMinute,
  };

  const parsedHour = getSingleCronNumber(hour, { max: 23, min: 0 });
  if (parsedHour !== null) {
    interval.Hour = parsedHour;
  } else if (hour !== "*") {
    return null;
  }

  const parsedDay = getSingleCronNumber(day, { max: 31, min: 1 });
  if (parsedDay !== null) {
    interval.Day = parsedDay;
  } else if (day !== "*") {
    return null;
  }

  const parsedMonth = getSingleCronNumber(month, { max: 12, min: 1 });
  if (parsedMonth !== null) {
    interval.Month = parsedMonth;
  } else if (month !== "*") {
    return null;
  }

  const parsedWeekday = getSingleCronNumber(weekday, { max: 7, min: 0 });
  if (parsedWeekday !== null) {
    interval.Weekday = parsedWeekday === 7 ? 0 : parsedWeekday;
  } else if (weekday !== "*") {
    return null;
  }

  return interval;
}

function createLaunchAgentPlist({
  calendarInterval,
  cwd,
  label,
  logPath,
}: {
  calendarInterval: CalendarInterval;
  cwd: string;
  label: string;
  logPath: string;
}): string {
  const cliPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const programArguments = [
    process.execPath,
    cliPath,
    "ingest",
    "all",
    "--scheduled",
    "--print",
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${escapePlist(arg)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapePlist(cwd)}</string>
  <key>StandardOutPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(logPath)}</string>
  <key>StartCalendarInterval</key>
  <dict>
${Object.entries(calendarInterval)
  .map(
    ([key, value]) => `    <key>${key}</key>
    <integer>${value}</integer>`,
  )
  .join("\n")}
  </dict>
</dict>
</plist>
`;
}

function getLaunchdDomain(): string {
  return `gui/${process.getuid?.() ?? os.userInfo().uid}`;
}

function getLaunchAgentLabel(): string {
  return "com.openwiki.ingestion";
}

function getLaunchAgentsDir(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents");
}

function getLaunchAgentPath(): string {
  return path.join(getLaunchAgentsDir(), `${getLaunchAgentLabel()}.plist`);
}

async function unloadLaunchAgent(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  await execFileAsync("launchctl", [
    "bootout",
    `${getLaunchdDomain()}/${getLaunchAgentLabel()}`,
  ]).catch(() => null);
}

async function removeLaunchAgentPlist(): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  await unlink(getLaunchAgentPath()).catch((error: unknown) => {
    if (isFileNotFoundError(error)) {
      return;
    }

    throw error;
  });
}

async function isLaunchAgentLoaded(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }

  try {
    await execFileAsync("launchctl", [
      "print",
      `${getLaunchdDomain()}/${getLaunchAgentLabel()}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function escapePlist(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
