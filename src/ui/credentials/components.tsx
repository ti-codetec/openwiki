import React from "react";
import { Box, Text } from "ink";
import {
  getProviderLabel,
  type OpenWikiProvider,
} from "../../providers/config.js";
import { CRON_FIELD_LABELS, getCronFields } from "../../schedules/cron.js";
import {
  formatSecretInputDisplay,
  formatTerminalHyperlink,
  getSingleLineInputDisplayValue,
} from "./input-utils.js";

/**
 * The banner shown at the top of the first-run setup wizard.
 */
export function SetupHeader() {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
    >
      <Text>
        <Text bold color="cyan">
          OpenWiki
        </Text>{" "}
        <Text color="gray">first-run setup</Text>
      </Text>
      <Text>Configure the model, wiki scope, and sources.</Text>
    </Box>
  );
}

/**
 * A single line in the setup checklist, colored by its progress state.
 */
export function SetupStep({
  detail,
  label,
  state,
}: {
  detail: string;
  label: string;
  state: "current" | "done" | "optional" | "pending";
}) {
  const color =
    state === "done"
      ? "green"
      : state === "current"
        ? "yellow"
        : state === "optional"
          ? "cyan"
          : "gray";

  return (
    <Text>
      <Text color={color}>[{state.toUpperCase()}]</Text>{" "}
      <Text bold>{label.padEnd(16)}</Text> <Text color="gray">{detail}</Text>
    </Text>
  );
}

/**
 * A titled, bordered container for the active step's prompt content.
 */
export function SetupPanel({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      flexDirection="column"
      marginTop={1}
      paddingX={1}
    >
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}

/**
 * The `>` gutter marker rendered beside the currently selected menu row.
 */
export function SelectionMarker({ isSelected }: { isSelected: boolean }) {
  return (
    <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>
  );
}

/**
 * A source's connection status badge, showing the configured instance count.
 */
export function SourceConnectionStatus({
  count,
  isConfigured,
}: {
  count: number;
  isConfigured: boolean;
}) {
  return (
    <Text color={isConfigured ? "green" : "gray"}>
      {isConfigured
        ? `[configured${count > 1 ? ` x${count}` : ""}]`
        : "[not configured]"}
    </Text>
  );
}

/**
 * The clickable authorization link plus its copyable raw URL fallback, shown
 * during connector OAuth.
 */
export function OAuthAuthorizationLink({
  copiedToClipboard,
  url,
}: {
  copiedToClipboard: boolean;
  url: string;
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color="cyan" underline>
          {formatTerminalHyperlink(url, "Open authorization URL")}
        </Text>
      </Text>
      <Text color={copiedToClipboard ? "green" : "gray"}>
        {copiedToClipboard
          ? "Full URL copied to clipboard. It is also shown below."
          : "Copy the full raw URL below if the link is not clickable."}
      </Text>
      <Text color="gray" wrap="wrap">
        {url}
      </Text>
    </Box>
  );
}

/**
 * The ChatGPT sign-in prompt: browser instructions, the login URL, and the
 * paste-fallback input for headless machines.
 */
export function OAuthLoginPrompt({
  copied,
  input,
  isLoggingIn,
  loginUrl,
  provider,
}: {
  copied: boolean;
  input: string;
  isLoggingIn: boolean;
  loginUrl: string | null;
  provider: OpenWikiProvider;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        ChatGPT login
      </Text>
      <Text>
        Sign in with your {getProviderLabel(provider)} account to authorize
        OpenWiki.
      </Text>
      {loginUrl ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">
            Opening your browser. If it does not open, copy this URL:
          </Text>
          <Text color="cyan" wrap="wrap">
            {loginUrl}
          </Text>
          <Text color="gray">
            Press <Text bold>c</Text> to copy the URL
            {copied ? <Text color="green"> (copied)</Text> : null}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">
              If the browser cannot reach this machine, paste the redirect URL
              or authorization code and press Enter:
            </Text>
            <Text>
              <Text color="gray">&gt; </Text>
              {input.length > 0 ? (
                <Text color="yellow">{input}</Text>
              ) : (
                <Text color="gray">(paste here)</Text>
              )}
            </Text>
          </Box>
        </Box>
      ) : (
        <Text color="gray">Starting the ChatGPT login...</Text>
      )}
      <Text color="gray">
        {isLoggingIn
          ? "Waiting for browser sign-in or pasted URL..."
          : "Login failed. Press Enter to retry."}
      </Text>
    </Box>
  );
}

/**
 * A single-line bordered text input with a prompt glyph, optional `$`-prefix,
 * and secret masking, sized to `maxDisplayWidth`.
 */
export function BorderedInput({
  borderColor = "cyan",
  maxDisplayWidth,
  marginTop,
  prefix,
  secret = false,
  showCursor = true,
  value,
}: {
  borderColor?: "cyan" | "gray";
  maxDisplayWidth: number;
  marginTop?: number;
  prefix?: string;
  secret?: boolean;
  showCursor?: boolean;
  value: string;
}) {
  const prompt = prefix ? "$ " : "> ";
  const prefixText = prefix ? `${prefix} ` : "";
  const valueDisplayWidth = Math.max(
    1,
    maxDisplayWidth - prompt.length - prefixText.length - (showCursor ? 1 : 0),
  );

  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      marginTop={marginTop}
      paddingX={1}
      width={maxDisplayWidth + 4}
    >
      <Text wrap="truncate">
        <Text color="gray">{prompt}</Text>
        {prefixText ? <Text color="gray">{prefixText}</Text> : null}
        <InputValueWithCursor
          maxDisplayWidth={valueDisplayWidth}
          secret={secret}
          showCursor={showCursor}
          value={value}
        />
      </Text>
    </Box>
  );
}

/**
 * A multi-line bordered text input that wraps its value and shows a cursor.
 */
export function BorderedMultilineInput({
  borderColor = "cyan",
  maxDisplayWidth,
  marginTop,
  showCursor = true,
  value,
}: {
  borderColor?: "cyan" | "gray";
  maxDisplayWidth: number;
  marginTop?: number;
  showCursor?: boolean;
  value: string;
}) {
  return (
    <Box
      borderStyle="single"
      borderColor={borderColor}
      flexDirection="column"
      marginTop={marginTop}
      paddingX={1}
      width={maxDisplayWidth + 4}
    >
      <Text wrap="wrap">
        <Text color="gray">&gt; </Text>
        {value ? <Text color="yellow">{value}</Text> : null}
        {showCursor ? <Text inverse> </Text> : null}
      </Text>
    </Box>
  );
}

/**
 * Renders an input value truncated to fit, masking it when `secret`, with a
 * trailing block cursor.
 */
export function InputValueWithCursor({
  maxDisplayWidth,
  secret = false,
  showCursor = true,
  value,
}: {
  maxDisplayWidth: number;
  secret?: boolean;
  showCursor?: boolean;
  value: string;
}) {
  if (secret) {
    const displayValue = getSingleLineInputDisplayValue(
      formatSecretInputDisplay(value),
      maxDisplayWidth,
    );

    return (
      <>
        <Text color={value.length > 0 ? "yellow" : "gray"}>{displayValue}</Text>
        {showCursor ? <Text inverse> </Text> : null}
      </>
    );
  }

  const displayValue = getSingleLineInputDisplayValue(value, maxDisplayWidth);

  return (
    <>
      {displayValue ? <Text color="yellow">{displayValue}</Text> : null}
      {showCursor ? <Text inverse> </Text> : null}
    </>
  );
}

/**
 * The five-field segmented cron editor, highlighting the active field and
 * previewing the assembled expression.
 */
export function SegmentedCronInput({
  activeFieldIndex,
  expression,
  fallbackExpression,
  maxDisplayWidth,
}: {
  activeFieldIndex: number;
  expression: string;
  fallbackExpression: string;
  maxDisplayWidth: number;
}) {
  const fields = getCronFields(expression, fallbackExpression);
  const fieldDisplayWidth = Math.max(
    8,
    Math.min(14, Math.floor(maxDisplayWidth / CRON_FIELD_LABELS.length) - 1),
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {fields.map((field, index) => (
          <Box
            flexDirection="column"
            marginRight={1}
            key={CRON_FIELD_LABELS[index]}
          >
            <Text color="gray">{CRON_FIELD_LABELS[index]}</Text>
            <BorderedInput
              borderColor={index === activeFieldIndex ? "cyan" : "gray"}
              maxDisplayWidth={fieldDisplayWidth}
              showCursor={index === activeFieldIndex}
              value={field}
            />
          </Box>
        ))}
      </Box>
      <Text color="gray">Cron: {fields.join(" ")}</Text>
    </Box>
  );
}
