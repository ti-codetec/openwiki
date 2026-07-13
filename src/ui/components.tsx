import React from "react";
import { Box, Text } from "ink";
import type { HelpRow } from "../cli/help.js";

interface PanelProps {
  title: string;
  children: React.ReactNode;
}

/**
 * A titled section: a `# Title` heading with its children indented beneath it.
 */
export function Panel({ title, children }: PanelProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color="cyan"># </Text>
        <Text bold>{title}</Text>
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

interface RowsProps {
  rows: HelpRow[];
}

/**
 * A two-column label/description list, with the label column padded so the
 * descriptions line up.
 */
export function Rows({ rows }: RowsProps) {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));

  return (
    <>
      {rows.map((row) => (
        <Text key={row.label}>
          {"  "}
          {row.label.padEnd(labelWidth)}
          {"  "}
          {row.description}
        </Text>
      ))}
    </>
  );
}

interface StatusLineProps {
  tone: "active" | "error" | "muted" | "success";
  label: string;
  value: string;
}

/**
 * A `* label value` line colored by tone: green for success, red for error,
 * yellow for active, gray for muted.
 */
export function StatusLine({ tone, label, value }: StatusLineProps) {
  const color =
    tone === "success"
      ? "green"
      : tone === "error"
        ? "red"
        : tone === "active"
          ? "yellow"
          : "gray";

  return (
    <Text>
      <Text color={color}>* </Text>
      <Text bold color={color}>
        {label}
      </Text>{" "}
      <Text color={tone === "muted" ? "gray" : undefined}>{value}</Text>
    </Text>
  );
}

/**
 * A one-line echo of a user prompt, rendered with a `>` marker on a subtle
 * background.
 */
export function PromptBlock({ message }: { message: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text backgroundColor="gray" wrap="wrap">
        {" "}
        <Text color="cyan">{">"}</Text> {message}
      </Text>
    </Box>
  );
}
