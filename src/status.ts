import { loadConfig } from "./config.js";
import { scanRepository } from "./scanner.js";
import { loadSnapshot, loadState } from "./state.js";

export async function getProjectStatus(root: string) {
  const [config, state] = await Promise.all([loadConfig(root), loadState(root)]);
  const scan = await scanRepository(root, config);
  if (!state.activeSnapshotId) {
    return { state, scan, snapshot: null, created: [], modified: [], deleted: [], redacted: [] };
  }
  const snapshot = await loadSnapshot(root, state.activeSnapshotId);
  const current = new Map(scan.files.map((file) => [file.path, file]));
  const skipped = new Map(scan.skipped.map((file) => [file.path, file]));
  const basePaths = new Set(Object.keys(snapshot.files));
  const created = scan.files.filter((file) => !basePaths.has(file.path)).map((file) => file.path);
  const modified = scan.files.filter((file) => snapshot.files[file.path]?.hash !== file.hash && basePaths.has(file.path)).map((file) => file.path);
  const deleted = Object.keys(snapshot.files).filter((filePath) => !current.has(filePath) && !skipped.has(filePath));
  const redacted = Object.keys(snapshot.files).filter((filePath) => skipped.has(filePath));
  return { state, scan, snapshot, created, modified, deleted, redacted };
}
