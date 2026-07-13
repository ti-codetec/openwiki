import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OpenWikiOnboardingConfig } from "../onboarding/store.js";
import { getSingleCronNumber, parseSimpleCronFields } from "./cron.js";

const execFileAsync = promisify(execFile);

const PMSET_WAKE_OFFSET_MINUTES = 2;
const PMSET_SLEEP_OFFSET_MINUTES = 30;
const PMSET_DEFAULT_DAYS = "MTWRFSU";

/**
 * The result of installing, or attempting to install, the macOS repeat
 * wake/sleep schedule.
 */
export interface PowerScheduleInstallResult {
  /**
   * The pmset day set the window applies to (e.g. `MTWRF`).
   */
  days: string;

  /**
   * Whether the schedule was actually installed. False when it was skipped
   * (no representable window) or the platform is not macOS.
   */
  enabled: boolean;

  /**
   * The scheduled sleep time as `HH:MM:SS`, or empty when none was installed.
   */
  sleepTime: string;

  /**
   * The scheduled wake time as `HH:MM:SS`, or empty when none was installed.
   */
  wakeTime: string;

  /**
   * A human note explaining why the schedule was or was not installed; absent
   * when there is nothing to report.
   */
  warning?: string;
}

/**
 * A saved power schedule's status: an install result plus when it was written.
 */
export interface PowerScheduleStatus extends PowerScheduleInstallResult {
  /**
   * ISO timestamp of when the schedule was last saved.
   */
  updatedAt: string;
}

/**
 * A single schedule reduced to the pmset day set and minute-of-day it wakes at.
 */
interface RepeatScheduleTime {
  /**
   * The pmset day set this schedule runs on.
   */
  days: string;

  /**
   * Minutes since midnight of the scheduled time.
   */
  minuteOfDay: number;
}

/**
 * Installs or updates the single macOS repeat wake/sleep window that covers the
 * config's active ingestion schedule. Returns a disabled result with a warning
 * when there is nothing installable or the platform is not macOS.
 */
export async function installOpenWikiPowerSchedule(
  config: OpenWikiOnboardingConfig,
): Promise<PowerScheduleInstallResult> {
  const powerWindow = getPowerWindowForConfiguredSchedules(config);

  if (!powerWindow) {
    return {
      days: PMSET_DEFAULT_DAYS,
      enabled: false,
      sleepTime: "",
      wakeTime: "",
      warning:
        "Wake setup skipped because no saved schedules can be represented as a simple macOS repeat wake window.",
    };
  }

  if (process.platform !== "darwin") {
    return {
      ...powerWindow,
      enabled: false,
      warning: "Wake setup is currently macOS-only.",
    };
  }

  const pmsetArgs = [
    "repeat",
    "wakeorpoweron",
    powerWindow.days,
    powerWindow.wakeTime,
    "sleep",
    powerWindow.days,
    powerWindow.sleepTime,
  ];

  try {
    await execFileAsync("osascript", [
      "-e",
      `do shell script ${toAppleScriptString(
        pmsetCommand(pmsetArgs),
      )} with administrator privileges`,
    ]);

    return {
      ...powerWindow,
      enabled: true,
      warning:
        "macOS supports one repeat power schedule. OpenWiki updated it to cover the currently saved connector schedules.",
    };
  } catch (error) {
    return {
      ...powerWindow,
      enabled: false,
      warning: `Wake setup was not installed: ${getErrorMessage(error)}`,
    };
  }
}

/**
 * The macOS power schedule saved in the config, or `null` when none has been
 * saved.
 */
export function getSavedPowerScheduleStatus(
  config: OpenWikiOnboardingConfig,
): PowerScheduleStatus | null {
  const savedPmset = config.powerManagement?.pmset;

  if (!savedPmset) {
    return null;
  }

  return {
    days: savedPmset.days,
    enabled: savedPmset.enabled,
    sleepTime: savedPmset.sleepTime,
    updatedAt: savedPmset.updatedAt,
    wakeTime: savedPmset.wakeTime,
    warning: savedPmset.warning,
  };
}

/**
 * Reconciles the saved power schedule with the config's ingestion schedule:
 * installs or updates the wake window when a schedule is active, cancels it
 * when none is, and returns the config with the updated power state.
 */
export async function reconcileOpenWikiPowerSchedule(
  config: OpenWikiOnboardingConfig,
): Promise<{
  config: OpenWikiOnboardingConfig;
  powerSchedule?: PowerScheduleInstallResult;
}> {
  const savedPmset = config.powerManagement?.pmset;
  if (!savedPmset) {
    return { config };
  }

  if (!hasActiveIngestionSchedule(config)) {
    if (!savedPmset.enabled) {
      return { config };
    }

    const result = await cancelOpenWikiPowerSchedule();
    return {
      config: {
        ...config,
        powerManagement: {
          ...config.powerManagement,
          pmset: {
            days: savedPmset.days,
            enabled: false,
            sleepTime: savedPmset.sleepTime,
            updatedAt: new Date().toISOString(),
            wakeTime: savedPmset.wakeTime,
            warning: result.warning,
          },
        },
      },
      powerSchedule: result,
    };
  }

  const result = await installOpenWikiPowerSchedule(config);
  return {
    config: {
      ...config,
      powerManagement: {
        ...config.powerManagement,
        pmset: {
          days: result.days,
          enabled: result.enabled,
          sleepTime: result.sleepTime,
          updatedAt: new Date().toISOString(),
          wakeTime: result.wakeTime,
          warning: result.warning,
        },
      },
    },
    powerSchedule: result,
  };
}

async function cancelOpenWikiPowerSchedule(): Promise<PowerScheduleInstallResult> {
  const disabledSchedule = {
    days: "",
    enabled: false,
    sleepTime: "",
    wakeTime: "",
  };

  if (process.platform !== "darwin") {
    return {
      ...disabledSchedule,
      warning: "Wake setup is currently macOS-only.",
    };
  }

  try {
    await execFileAsync("osascript", [
      "-e",
      `do shell script ${toAppleScriptString(
        pmsetCommand(["repeat", "cancel"]),
      )} with administrator privileges`,
    ]);

    return {
      ...disabledSchedule,
      warning: "OpenWiki removed the macOS repeat wake/sleep schedule.",
    };
  } catch (error) {
    return {
      ...disabledSchedule,
      warning: `Wake setup was not removed: ${getErrorMessage(error)}`,
    };
  }
}

function hasActiveIngestionSchedule(config: OpenWikiOnboardingConfig): boolean {
  return Boolean(
    config.ingestionSchedule && !config.ingestionSchedule.pausedAt,
  );
}

function getPowerWindowForConfiguredSchedules(
  config: OpenWikiOnboardingConfig,
): Omit<PowerScheduleInstallResult, "enabled" | "warning"> | null {
  const parsedSchedules: RepeatScheduleTime[] = [];
  const schedule = config.ingestionSchedule;

  if (schedule && !schedule.pausedAt) {
    const parsedSchedule = parseRepeatScheduleTime(schedule.expression);
    if (parsedSchedule) {
      parsedSchedules.push(parsedSchedule);
    }
  }

  if (parsedSchedules.length === 0) {
    return null;
  }

  const days = mergePmsetDays(parsedSchedules.map((schedule) => schedule.days));
  const earliestMinute = Math.min(
    ...parsedSchedules.map((schedule) => schedule.minuteOfDay),
  );
  const latestMinute = Math.max(
    ...parsedSchedules.map((schedule) => schedule.minuteOfDay),
  );
  const wakeMinute = earliestMinute - PMSET_WAKE_OFFSET_MINUTES;
  const sleepMinute = latestMinute + PMSET_SLEEP_OFFSET_MINUTES;

  if (wakeMinute < 0 || sleepMinute >= 24 * 60) {
    return null;
  }

  return {
    days,
    sleepTime: formatPmsetTime(sleepMinute),
    wakeTime: formatPmsetTime(wakeMinute),
  };
}

function parseRepeatScheduleTime(
  expression: string,
): RepeatScheduleTime | null {
  const parsed = parseSimpleCronFields(expression);
  if (!parsed) {
    return null;
  }

  if (parsed.day !== "*" || parsed.month !== "*") {
    return null;
  }

  const minute = getSingleCronNumber(parsed.minute, { max: 59, min: 0 });
  const hour = getSingleCronNumber(parsed.hour, { max: 23, min: 0 });
  if (minute === null || hour === null) {
    return null;
  }

  const days = parsePmsetDays(parsed.weekday);
  if (!days) {
    return null;
  }

  return {
    days,
    minuteOfDay: hour * 60 + minute,
  };
}

function parsePmsetDays(weekday: string): string | null {
  if (weekday === "*") {
    return PMSET_DEFAULT_DAYS;
  }

  const parsedWeekday = getSingleCronNumber(weekday, { max: 7, min: 0 });
  if (parsedWeekday === null) {
    return null;
  }

  return weekdayNumberToPmsetDay(parsedWeekday);
}

function weekdayNumberToPmsetDay(weekday: number): string {
  switch (weekday === 7 ? 0 : weekday) {
    case 0:
      return "U";
    case 1:
      return "M";
    case 2:
      return "T";
    case 3:
      return "W";
    case 4:
      return "R";
    case 5:
      return "F";
    case 6:
      return "S";
    default:
      return "";
  }
}

function mergePmsetDays(days: string[]): string {
  const dayOrder = PMSET_DEFAULT_DAYS.split("");
  const usedDays = new Set(days.flatMap((daySet) => daySet.split("")));
  return dayOrder.filter((day) => usedDays.has(day)).join("");
}

function formatPmsetTime(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:00`;
}

function pmsetCommand(args: string[]): string {
  return ["pmset", ...args].map(toShellSingleQuotedArg).join(" ");
}

function toShellSingleQuotedArg(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function toAppleScriptString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
