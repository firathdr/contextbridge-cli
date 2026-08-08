import { loadConfig } from "./config.js";
import { buildHandoffPackage } from "./format.js";
import { publishOutput } from "./output.js";
import { rankFiles } from "./relevance.js";
import { scanRepository } from "./scanner.js";
import { activateSnapshot, createStateId, snapshotFromScan } from "./state.js";

export async function createHandoff(root: string, task: string, options: { budget?: number; copy: boolean }) {
  const config = await loadConfig(root);
  const tokenBudget = options.budget ?? config.context.tokenBudget;
  if (!Number.isInteger(tokenBudget) || tokenBudget < 1_000) throw new Error("Token budget must be an integer of at least 1000.");
  const scan = await scanRepository(root, config);
  const ranked = rankFiles(scan, task, config.context.includeTests);
  const snapshotId = createStateId("cb");
  const packaged = buildHandoffPackage({ scan, ranked, snapshotId, task, tokenBudget });
  const snapshot = snapshotFromScan(scan, "handoff", task, snapshotId);
  const published = await publishOutput(root, "handoff", snapshotId, packaged.output, options.copy);
  await activateSnapshot(root, snapshot);
  return { scan, snapshot, ...packaged, published, tokenBudget };
}

