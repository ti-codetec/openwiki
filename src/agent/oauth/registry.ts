import type { OpenWikiProvider } from "../../constants.js";
import type { OAuthAdapter } from "./types.js";
import { openaiChatgptAdapter } from "./openai-chatgpt.js";
import { anthropicClaudeAdapter } from "./anthropic-claude.js";

/**
 * Returns the OAuth adapter for a provider, or undefined if it is not an OAuth
 * provider.
 */
export function getOAuthAdapter(
  provider: OpenWikiProvider,
): OAuthAdapter | undefined {
  switch (provider) {
    case "openai-chatgpt":
      return openaiChatgptAdapter;
    case "claude-oauth":
      return anthropicClaudeAdapter;
    default:
      return undefined;
  }
}
