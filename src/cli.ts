#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import clipboard from "clipboardy";
import { Command } from "commander";
import { applyChangeDocument, prepareChanges, undoLastApply } from "./apply.js";
import { parseChanges } from "./change-parser.js";
import { collectGitContext } from "./git.js";
import { createHandoff } from "./handoff.js";
import { findProjectRoot, initializeProject } from "./project.js";
import { getProjectStatus } from "./status.js";
import { createSync } from "./sync.js";

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function relativeDisplay(root: string, target: string): string {
  return path.relative(root, target).replaceAll("\\", "/");
}

async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("Interactive confirmation is unavailable. Review the diff and pass --yes to continue.");
  const readline = createInterface({ input, output });
  try {
    const answer = (await readline.question(`${message} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

async function readChangeInput(file?: string): Promise<string> {
  if (file) return readFile(path.resolve(file), "utf8");
  try {
    return await clipboard.read();
  } catch (error) {
    throw new Error(`Could not read the clipboard: ${error instanceof Error ? error.message : String(error)}. Use --file <path> as a fallback.`);
  }
}

const program = new Command()
  .name("cb")
  .description("Local-first coding-context handoff between repositories and web AI chats")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize ContextBridge in the current project")
  .action(async () => {
    const result = await initializeProject();
    console.log(result.created ? `Initialized ContextBridge in ${result.root}` : `ContextBridge is already initialized in ${result.root}`);
    console.log("State is stored locally in .contextbridge/ and ignored by Git.");
  });

program
  .command("handoff")
  .description("Create a task-aware package for a new web AI chat")
  .argument("[task]", "active coding task", "")
  .option("-b, --budget <tokens>", "local token budget", (value) => Number.parseInt(value, 10))
  .option("--no-copy", "do not copy the package to the clipboard")
  .option("--stdout", "also print the full package")
  .action(async (task: string, options: { budget?: number; copy: boolean; stdout?: boolean }) => {
    const root = await findProjectRoot();
    console.log("Analyzing repository locally…");
    const result = await createHandoff(root, task, options);
    console.log(`Files scanned: ${formatNumber(result.scan.files.length)} (${formatNumber(result.scan.totalTokens)} tokens)`);
    console.log(`Files selected: ${formatNumber(result.selected.length)} (${formatNumber(result.tokenCount)} package tokens)`);
    console.log(`Snapshot: ${result.snapshot.id}`);
    console.log(`Saved: ${relativeDisplay(root, result.published.path)}`);
    if (result.published.copied) console.log("Context package copied to clipboard.");
    if (result.published.clipboardError) console.warn(`Clipboard unavailable; use the saved output file. ${result.published.clipboardError}`);
    if (result.scan.skipped.length > 0) console.log(`Safely skipped: ${result.scan.skipped.length} binary, oversized, or secret-bearing file(s)`);
    if (options.stdout) console.log(`\n${result.output}`);
  });

program
  .command("sync")
  .description("Create an incremental update since the active snapshot")
  .option("-b, --budget <tokens>", "local token budget", (value) => Number.parseInt(value, 10))
  .option("--no-copy", "do not copy the update to the clipboard")
  .option("--stdout", "also print the full update")
  .action(async (options: { budget?: number; copy: boolean; stdout?: boolean }) => {
    const root = await findProjectRoot();
    console.log("Comparing repository with the active snapshot…");
    const result = await createSync(root, options);
    if (!result.changed) {
      console.log(`No changes since ${result.base.id}.`);
      return;
    }
    console.log(`Created: ${result.created.length}, modified: ${result.modified.length}, deleted: ${result.deleted.length}, redacted: ${result.redacted.length}`);
    console.log(`Update tokens: ${formatNumber(result.tokenCount)}`);
    console.log(`Snapshot: ${result.next.id}`);
    console.log(`Saved: ${relativeDisplay(root, result.published.path)}`);
    if (result.published.copied) console.log("Incremental update copied to clipboard.");
    if (result.published.clipboardError) console.warn(`Clipboard unavailable; use the saved output file. ${result.published.clipboardError}`);
    if (options.stdout) console.log(`\n${result.output}`);
  });

program
  .command("apply")
  .description("Preview and apply a strict ContextBridge change document")
  .option("-f, --file <path>", "read changes from a file instead of the clipboard")
  .option("-y, --yes", "apply after preview without interactive confirmation", false)
  .action(async (options: { file?: string; yes: boolean }) => {
    const root = await findProjectRoot();
    const document = await readChangeInput(options.file);
    const operations = parseChanges(document);
    const prepared = await prepareChanges(root, operations);
    const git = await collectGitContext(root, true);
    if (git.available && git.dirty.size > 0) {
      console.warn(`Warning: repository contains ${git.dirty.size} uncommitted path(s). Backups will be created.`);
    }
    console.log(`\n${operations.length} change operation(s):`);
    for (const operation of operations) {
      console.log(`${operation.kind === "create" ? "+" : operation.kind === "delete" ? "-" : "M"} ${operation.path}`);
    }
    for (const item of prepared) console.log(`\n${item.diff}`);
    const result = await applyChangeDocument(root, document, { yes: options.yes, confirm });
    if (!result.applied) {
      console.log("Apply cancelled; no files changed.");
      return;
    }
    console.log(`Applied ${result.operations.length} operation(s). Backup: ${result.id}`);
    console.log("Run `cb undo` to revert this apply operation.");
  });

program
  .command("status")
  .description("Show active snapshot and repository changes")
  .action(async () => {
    const root = await findProjectRoot();
    const result = await getProjectStatus(root);
    console.log(`Project: ${path.basename(root)}`);
    console.log(`Files tracked: ${formatNumber(result.scan.files.length)}`);
    console.log(`Repository tokens: ${formatNumber(result.scan.totalTokens)}`);
    console.log(`Active snapshot: ${result.snapshot?.id ?? "none"}`);
    console.log(`Changed since snapshot: +${result.created.length} M${result.modified.length} -${result.deleted.length} redacted:${result.redacted.length}`);
    console.log(`Last reversible apply: ${result.state.lastApplyId ?? "none"}`);
    if (result.scan.skipped.length > 0) console.log(`Safely skipped: ${result.scan.skipped.length}`);
  });

program
  .command("undo")
  .description("Revert the most recent ContextBridge apply operation")
  .option("-y, --yes", "undo without interactive confirmation", false)
  .option("--force", "overwrite files changed after apply", false)
  .action(async (options: { yes: boolean; force: boolean }) => {
    const root = await findProjectRoot();
    const result = await undoLastApply(root, { ...options, confirm });
    if (!result.undone) {
      console.log("Undo cancelled; no files changed.");
      return;
    }
    console.log(`Undid ${result.manifest.entries.length} operation(s) from ${result.manifest.id}.`);
  });

program.parseAsync().catch((error: unknown) => {
  console.error(`ContextBridge error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
