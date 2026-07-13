import type { OpenWikiRunMode } from "../cli/parse.js";
import type { ConnectorId, SourceSetupOption } from "../connectors/types.js";
import {
  deriveLegacySources,
  type OpenWikiOnboardingConfig,
  readRepositoryWikiInstructions,
} from "./store.js";

/**
 * A selectable onboarding mode (a.k.a. template): the wiki profile the user
 * picks at setup, carrying its default sources and a suggested wiki goal.
 */
export interface OnboardingMode {
  /**
   * One-line explanation of what the mode produces, shown in the menu.
   */
  description: string;

  /**
   * Stable identifier persisted as the onboarding config's `modeId`.
   */
  id: string;

  /**
   * Human-readable mode name shown in the UI.
   */
  name: string;

  /**
   * Connector ids offered by default for this mode.
   */
  sourceIds: ConnectorId[];

  /**
   * Display names of the suggested sources, shown as guidance in the menu.
   */
  suggestedSources: string[];

  /**
   * Pre-filled wiki goal offered when the user reaches the goal step.
   */
  suggestedGoal: string;
}

/**
 * The built-in onboarding modes offered at setup, in menu order.
 */
export const ONBOARDING_TEMPLATES = [
  {
    description:
      "Maintain a structured project wiki from a local Git repository, with code-oriented pages for architecture, workflows, source maps, and operational guidance.",
    id: "code",
    name: "Code",
    sourceIds: ["git-repo"],
    suggestedSources: ["Local Git repository"],
    suggestedGoal:
      "A code wiki for this local repository. Prioritize a concise quickstart, architecture overview, source map, key workflows, domain concepts, operations/runbook notes, testing guidance, and integration points. Inspect git history to understand reasoning behind code changes and the progression of the repository. Keep pages grounded in the repository structure and recent code changes. Prefer practical navigation for engineers over generic summaries.",
  },
  {
    description:
      "A personal assistant wiki that builds memory from email, notes, social/research sources, and web search so you can ask about projects, priorities, people, and recurring context.",
    id: "personal",
    name: "Personal",
    sourceIds: [
      "git-repo",
      "google",
      "notion",
      "web-search",
      "hackernews",
      "x",
    ],
    suggestedSources: [
      "Gmail",
      "Notion",
      "Web Search (Tavily)",
      "Hacker News",
      "X/Twitter",
    ],
    suggestedGoal:
      "Your personal brain. Track active projects, people, organizations, decisions, commitments, follow-ups, useful links, recurring themes, and fresh external signals. Organize the wiki so a personal assistant can answer what changed, what matters, what needs attention, and where supporting evidence came from. Be selective: summarize durable context and explicit action items, not every raw item.",
  },
] as const satisfies readonly OnboardingMode[];

/**
 * The run-mode picker options (personal vs. code), in menu order.
 */
export const RUN_MODE_OPTIONS = [
  {
    description:
      "Build a local personal brain wiki in ~/.openwiki/wiki from configured sources.",
    id: "personal",
    name: "Personal",
  },
  {
    description:
      "Build repository documentation in ./openwiki for this codebase.",
    id: "code",
    name: "Code",
  },
] as const satisfies readonly {
  description: string;
  id: OpenWikiRunMode;
  name: string;
}[];

/**
 * The onboarding mode's stable id, preferring the current `modeId` and falling
 * back to the legacy `templateId`; `undefined` when neither has been chosen.
 */
export function getConfigModeId(
  config: OpenWikiOnboardingConfig,
): string | undefined {
  return config.modeId ?? config.templateId;
}

/**
 * The onboarding mode's display name, preferring the current `modeName` and
 * falling back to the legacy `templateName`; `undefined` when neither is set.
 */
export function getConfigModeName(
  config: OpenWikiOnboardingConfig,
): string | undefined {
  return config.modeName ?? config.templateName;
}

/**
 * True when the onboarding config selects `code` mode (documenting a repo)
 * rather than `personal` mode.
 */
export function isCodeMode(config: OpenWikiOnboardingConfig): boolean {
  return getConfigModeId(config) === "code";
}

/**
 * Returns the config with its mode set to `mode`, applying that mode's template
 * defaults. A no-op when the config is already in that mode or the mode has no
 * matching template.
 */
export function ensureRunModeConfig(
  config: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
): OpenWikiOnboardingConfig {
  if (getConfigModeId(config) === mode) {
    return config;
  }

  const runModeTemplate = ONBOARDING_TEMPLATES.find(
    (option) => option.id === mode,
  );
  if (!runModeTemplate) {
    return config;
  }

  return {
    ...config,
    modeId: runModeTemplate.id,
    modeName: runModeTemplate.name,
    templateId: runModeTemplate.id,
    templateName: runModeTemplate.name,
  };
}

/**
 * For code mode, fills the wiki goal from the repository's stored instructions
 * when present; otherwise returns the config unchanged.
 */
export async function hydrateRunModeConfig(
  config: OpenWikiOnboardingConfig,
  mode: OpenWikiRunMode,
  repoRoot: string,
): Promise<OpenWikiOnboardingConfig> {
  if (mode !== "code") {
    return config;
  }

  const wikiGoal = await readRepositoryWikiInstructions(repoRoot);

  return wikiGoal ? { ...config, wikiGoal } : config;
}

/**
 * The index of a run mode within the run-mode menu, clamped to 0 when the mode
 * is not one of the options.
 */
export function getRunModeSelectionIndex(mode: OpenWikiRunMode): number {
  const index = RUN_MODE_OPTIONS.findIndex((option) => option.id === mode);
  return index === -1 ? 0 : index;
}

/**
 * The display name for a run mode, falling back to the raw mode id when it is
 * not one of the options.
 */
export function getRunModeName(mode: OpenWikiRunMode): string {
  return RUN_MODE_OPTIONS.find((option) => option.id === mode)?.name ?? mode;
}

/**
 * The suggested wiki goal for a template id, or an empty string when the id is
 * unknown.
 */
export function getTemplateGoal(templateId: string | undefined): string {
  return (
    ONBOARDING_TEMPLATES.find((template) => template.id === templateId)
      ?.suggestedGoal ?? ""
  );
}

/**
 * Appends a source instance to the config and recomputes the derived legacy
 * `sources` map.
 */
export function addSourceInstanceConfig(
  config: OpenWikiOnboardingConfig,
  sourceInstance: OpenWikiOnboardingConfig["sourceInstances"][number],
): OpenWikiOnboardingConfig {
  const sourceInstances = [...config.sourceInstances, sourceInstance];
  return {
    ...config,
    sourceInstances,
    sources: deriveLegacySources(sourceInstances),
  };
}

/**
 * How many instances of a given connector are configured.
 */
export function getSourceInstanceCount(
  config: OpenWikiOnboardingConfig,
  sourceId: ConnectorId,
): number {
  return getSourceInstances(config, sourceId).length;
}

/**
 * The configured instances for a given connector.
 */
export function getSourceInstances(
  config: OpenWikiOnboardingConfig,
  sourceId: ConnectorId,
): OpenWikiOnboardingConfig["sourceInstances"] {
  return config.sourceInstances.filter(
    (sourceInstance) => sourceInstance.connectorId === sourceId,
  );
}

/**
 * How many configured instances belong to the given set of source options,
 * used to show progress across a mode's offered sources.
 */
export function getConnectedSourceCount(
  config: OpenWikiOnboardingConfig,
  sourceOptions: readonly SourceSetupOption[],
): number {
  const sourceIds = new Set(sourceOptions.map((source) => source.id));
  return config.sourceInstances.filter((sourceInstance) =>
    sourceIds.has(sourceInstance.connectorId),
  ).length;
}

/**
 * A stable id for a new source instance, numbered after the connector's
 * existing instances (e.g. `notion-2`).
 */
export function createSourceInstanceId(
  sourceId: ConnectorId,
  config: OpenWikiOnboardingConfig,
): string {
  const sourceCount = getSourceInstanceCount(config, sourceId) + 1;
  return `${sourceId}-${sourceCount}`;
}

/**
 * A human-readable name for a new source instance, combining the source's
 * display name, its instance number, and a trimmed description, capped at 120
 * characters.
 */
export function createSourceInstanceName(
  source: SourceSetupOption,
  description: string,
  config: OpenWikiOnboardingConfig,
): string {
  const sourceCount = getSourceInstanceCount(config, source.id) + 1;
  const trimmedDescription = description.trim();
  const suffix = trimmedDescription.length > 0 ? `: ${trimmedDescription}` : "";
  return `${source.displayName} ${sourceCount}${suffix}`.slice(0, 120);
}
