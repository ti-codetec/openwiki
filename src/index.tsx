#!/usr/bin/env node
import { render } from "ink";
import { runAuthCommand } from "./cli/commands/auth.js";
import { runCronCommand } from "./cli/commands/cron.js";
import { runIngestCommand } from "./cli/commands/ingest.js";
import { runNgrokCommand } from "./cli/commands/ngrok.js";
import { runPrintCommand } from "./cli/run-print.js";
import {
  parseCommand,
  shouldRunNonInteractively,
  type CliCommand,
} from "./cli/parse.js";
import { loadOpenWikiEnv } from "./env.js";
import { resolveStartupCommand } from "./startup.js";
import { App } from "./ui/app.js";

const argv = process.argv.slice(2);
const parsedCommand = parseCommand(argv);

if (
  (parsedCommand.kind === "run" && !parsedCommand.dryRun) ||
  parsedCommand.kind === "auth" ||
  parsedCommand.kind === "cron" ||
  parsedCommand.kind === "ingest" ||
  parsedCommand.kind === "ngrok"
) {
  await loadOpenWikiEnv();
}

const command = await resolveStartupCommand(parsedCommand, {
  cwd: process.cwd(),
  isStdinTTY: Boolean(process.stdin.isTTY),
});

if (command.kind === "auth") {
  await runAuthCommand(command);
} else if (command.kind === "ngrok") {
  await runNgrokCommand(command);
} else if (command.kind === "cron") {
  await runCronCommand(command);
} else if (command.kind === "ingest") {
  await runIngestCommand(command);
} else if (shouldPrintStartupError(argv, parsedCommand, command)) {
  process.stderr.write(`${command.message}\n`);
  process.exitCode = command.exitCode;
} else if (shouldRunNonInteractively(command, process.stdin.isTTY === true)) {
  await runPrintCommand(command);
} else {
  render(<App command={command} />);
}

function argvRequestsPrint(argv: string[]): boolean {
  return argv.some((arg) => arg === "-p" || arg === "--print");
}

function shouldPrintStartupError(
  argv: string[],
  parsedCommand: CliCommand,
  command: CliCommand,
): command is Extract<CliCommand, { kind: "error" }> {
  return (
    command.kind === "error" &&
    (argvRequestsPrint(argv) ||
      !process.stdin.isTTY ||
      command.message.startsWith("openwiki --init requires a mode.") ||
      (parsedCommand.kind === "run" && parsedCommand.shouldStart))
  );
}
