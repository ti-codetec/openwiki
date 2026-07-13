import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import type { OpenWikiOnboardingConfig } from "../onboarding/store.js";

/**
 * Default hour of day (24h) used for a suggested daily schedule when the config
 * has none.
 */
const DEFAULT_FIRST_HOUR = 2;

/**
 * The outcome of validating a cron expression: on success the normalized
 * expression and a human description, on failure the offending expression and
 * an error message.
 */
export type CronValidationResult =
  | {
      description: string;
      expression: string;
      valid: true;
    }
  | {
      error: string;
      expression: string;
      valid: false;
    };

/**
 * Validates and normalizes a cron expression, returning either a description of
 * what it does or an actionable error.
 */
export function validateCronExpression(
  expression: string,
): CronValidationResult {
  const normalizedExpression = normalizeCronExpression(expression);

  if (!normalizedExpression) {
    return {
      error: "Enter a cron expression like 0 2 * * *.",
      expression: normalizedExpression,
      valid: false,
    };
  }

  try {
    CronExpressionParser.parse(normalizedExpression);
    return {
      description: describeCronExpression(normalizedExpression),
      expression: normalizedExpression,
      valid: true,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid cron schedule.",
      expression: normalizedExpression,
      valid: false,
    };
  }
}

/**
 * Renders a cron expression as a plain-English description (12-hour time).
 */
export function describeCronExpression(expression: string): string {
  return cronstrue.toString(expression, {
    throwExceptionOnParseError: true,
    use24HourTimeFormat: false,
  });
}

/**
 * The cron expression to suggest for a config: its configured ingestion
 * schedule, or a daily default at `DEFAULT_FIRST_HOUR`.
 */
export function getSuggestedCronExpression(
  config: OpenWikiOnboardingConfig,
): string {
  return (
    config.ingestionSchedule?.expression ?? `0 ${DEFAULT_FIRST_HOUR} * * *`
  );
}

/**
 * Collapses surrounding and repeated whitespace in a cron expression to single
 * spaces.
 */
function normalizeCronExpression(expression: string): string {
  return expression.trim().replace(/\s+/gu, " ");
}

/**
 * Splits a cron expression into its five named fields, or `null` when it does
 * not have exactly five fields.
 */
export function parseSimpleCronFields(expression: string): {
  day: string;
  hour: string;
  minute: string;
  month: string;
  weekday: string;
} | null {
  const [minute, hour, day, month, weekday, ...extra] =
    expression.split(/\s+/u);
  if (!minute || !hour || !day || !month || !weekday || extra.length > 0) {
    return null;
  }

  return {
    day,
    hour,
    minute,
    month,
    weekday,
  };
}

/**
 * Parses a single numeric cron field within `[min, max]`, or `null` when it is
 * missing, non-numeric, or out of range (i.e. not a plain single value).
 */
export function getSingleCronNumber(
  field: string | undefined,
  { max, min }: { max: number; min: number },
): number | null {
  if (!field || !/^\d+$/u.test(field)) {
    return null;
  }

  const value = Number(field);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * The five cron fields, in order, used to label and index the segmented cron
 * editor.
 */
export const CRON_FIELD_LABELS = ["minute", "hour", "day", "month", "weekday"];

/**
 * Splits a cron expression into its five fields, falling back to
 * `fallbackExpression` when the expression is blank and padding missing fields
 * with empty strings.
 */
export function getCronFields(
  expression: string,
  fallbackExpression: string,
): string[] {
  const source =
    expression.trim().length > 0 ? expression.trim() : fallbackExpression;
  const fields = source.split(/\s+/u);

  return CRON_FIELD_LABELS.map((_, index) => fields[index] ?? "");
}

/**
 * Interprets pasted text as cron fields: whitespace-separated tokens are each
 * sanitized, and a bare five-character run of digits/`*` is split into single
 * fields. Returns an empty array when the paste is not field-shaped.
 */
export function parseCronFieldPaste(inputValue: string): string[] {
  if (inputValue.trim().length === 0) {
    return [];
  }

  if (/\s/u.test(inputValue)) {
    return inputValue
      .trim()
      .split(/\s+/u)
      .map((field) => sanitizeCronInputChunk(field))
      .filter((field) => field.length > 0);
  }

  const compactValue = sanitizeCronInputChunk(inputValue);

  if (/^[0-9*]{5}$/u.test(compactValue)) {
    return compactValue.split("");
  }

  return [];
}

/**
 * Strips characters that are never valid in a cron field, keeping digits,
 * letters, and the cron operators (`* , / ? # L W . -`).
 */
export function sanitizeCronInputChunk(value: string): string {
  return value.replace(/[^A-Za-z0-9*,/?#LW.-]/gu, "");
}
