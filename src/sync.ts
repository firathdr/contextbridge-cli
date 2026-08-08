import { loadConfig } from "./config.js";
import { buildSyncPackage } from "./format.js";
import { publishOutput } from "./output.js";
import { scanRepository } from "./scanner.js";
import { activateSnapshot, createStateId, loadSnapshot, loadState, snapshotFromScan } from "./state.js";

export async function createSync(root: string, options: { copy: boolean; budget?: number }) {
  const state = await loadState(root);
  if (!state.activeSnapshotId) throw new Error("No active snapshot. Run `cb handoff \"<task>\"` first.");
  const base = await loadSnapshot(root, state.activeSnapshotId);
  const config = await loadConfig(root);
  const tokenBudget = options.budget ?? config.context.tokenBudget;
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1_000) throw new Error("Token budget must be an integer of at least 1000.");
  const scan = await scanRepository(root, config);
  const current = new Map(scan.files.map((file) => [file.path, file]));
  const skipped = new Map(scan.skipped.map((file) => [file.path, file]));
  const basePaths = new Set(Object.keys(base.files));
  const created = scan.files.filter((file) => !basePaths.has(file.path));
  const modified = scan.files.filter((file) => base.files[file.path] && base.files[file.path]?.hash !== file.hash);
  const deleted = Object.keys(base.files).filter((filePath) => !current.has(filePath) && !skipped.has(filePath)).sort();
  const redacted = Object.keys(base.files)
    .filter((filePath) => skipped.has(filePath))
    .map((filePath) => skipped.get(filePath)!)
    .sort((a, b) => a.path.localeCompare(b.path));

  if (created.length === 0 && modified.length === 0 && deleted.length === 0 && redacted.length === 0) {
    return { changed: false as const, base, scan, created, modified, deleted, redacted };
  }

  const nextId = createStateId("cb");
  const packaged = buildSyncPackage({ base, nextId, scan, created, modified, deleted, redacted });
  if (packaged.tokenCount > tokenBudget) {
    throw new Error(
      `Incremental update requires ${packaged.tokenCount} tokens, exceeding the ${tokenBudget} token budget. ` +
      `Re-run with --budget ${packaged.tokenCount} or increase context.tokenBudget in .contextbridge/config.json.`,
    );
  }
  const next = snapshotFromScan(scan, "sync", base.task, nextId);
  const published = await publishOutput(root, "sync", nextId, packaged.output, options.copy);
  await activateSnapshot(root, next);
  return { changed: true as const, base, next, scan, created, modified, deleted, redacted, ...packaged, published, tokenBudget };
}
