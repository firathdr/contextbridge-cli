import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { STATE_DIR } from "./constants.js";
import { loadConfig } from "./config.js";
import { parseChanges } from "./change-parser.js";
import { exists } from "./project.js";
import { scanRepository } from "./scanner.js";
import { detectSecretValue, resolveSafeProjectPath, secretFilenameReason } from "./security.js";
import { createStateId, loadSnapshot, loadState, saveSnapshot, saveState, snapshotFromScan } from "./state.js";
import type { ApplyManifest, ApplyManifestEntry, ChangeOperation } from "./types.js";

export interface PreparedOperation {
  operation: ChangeOperation;
  absolutePath: string;
  before: string;
  diff: string;
  mode?: number;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function removeIfExists(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function prepareChanges(root: string, operations: ChangeOperation[]): Promise<PreparedOperation[]> {
  const config = await loadConfig(root);
  const prepared: PreparedOperation[] = [];
  const targets = new Set<string>();
  for (const operation of operations) {
    const target = await resolveSafeProjectPath(root, operation.path);
    const targetKey = process.platform === "win32" ? target.absolute.toLowerCase() : target.absolute;
    if (targets.has(targetKey)) throw new Error(`Operations resolve to the same target: ${operation.path}`);
    targets.add(targetKey);
    const targetExists = await exists(target.absolute);
    if (secretFilenameReason(operation.path)) throw new Error(`Secret-file targets are not allowed: ${operation.path}`);
    if (operation.kind === "create" && targetExists) throw new Error(`Create target already exists: ${operation.path}`);
    if (operation.kind !== "create" && !targetExists) throw new Error(`${operation.kind} target does not exist: ${operation.path}`);
    let before = "";
    let mode: number | undefined;
    if (targetExists) {
      const stats = await lstat(target.absolute);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Target must be a regular file: ${operation.path}`);
      before = await readFile(target.absolute, "utf8");
      mode = stats.mode;
    }
    if (operation.content !== undefined) {
      if (Buffer.byteLength(operation.content) > config.context.maxFileBytes) {
        throw new Error(`Change exceeds maxFileBytes for ${operation.path}.`);
      }
      const secret = config.security.detectSecrets ? detectSecretValue(operation.content) : null;
      if (secret) throw new Error(`Potential ${secret} detected in proposed content for ${operation.path}.`);
    }
    const after = operation.kind === "delete" ? "" : operation.content ?? "";
    const oldName = operation.kind === "create" ? "/dev/null" : `a/${operation.path}`;
    const newName = operation.kind === "delete" ? "/dev/null" : `b/${operation.path}`;
    const diff = createTwoFilesPatch(oldName, newName, before, after, "before", "after", { context: 3 });
    prepared.push({ operation, absolutePath: target.absolute, before, diff, mode });
  }
  return prepared;
}

async function restoreFromManifest(root: string, manifest: ApplyManifest): Promise<void> {
  for (const entry of [...manifest.entries].reverse()) {
    const target = await resolveSafeProjectPath(root, entry.path);
    if (!entry.existedBefore) {
      await removeIfExists(target.absolute);
      continue;
    }
    if (!entry.backupPath) throw new Error(`Missing backup for ${entry.path}.`);
    await mkdir(path.dirname(target.absolute), { recursive: true });
    await copyFile(path.join(root, STATE_DIR, "backups", manifest.id, entry.backupPath), target.absolute);
  }
}

async function writeManifest(root: string, manifest: ApplyManifest): Promise<void> {
  const target = path.join(root, STATE_DIR, "backups", manifest.id, "manifest.json");
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function restoreStateBestEffort(root: string, state: Awaited<ReturnType<typeof loadState>>): Promise<void> {
  try {
    await saveState(root, { ...state });
  } catch {
    // Preserve the original failure; recovery errors are reported by the caller when file rollback fails.
  }
}

export async function applyChangeDocument(
  root: string,
  document: string,
  options: { yes: boolean; confirm?: (message: string) => Promise<boolean> },
) {
  const operations = parseChanges(document);
  const prepared = await prepareChanges(root, operations);
  const destructive = operations.some((operation) => operation.kind !== "create");
  if (!options.yes) {
    if (!options.confirm) throw new Error("Confirmation is required. Re-run interactively or pass --yes after reviewing the diff.");
    const accepted = await options.confirm(destructive ? "Apply these destructive changes?" : "Apply these changes?");
    if (!accepted) return { applied: false as const, operations, prepared };
  }

  const id = createStateId("apply");
  const backupRoot = path.join(root, STATE_DIR, "backups", id);
  await mkdir(backupRoot, { recursive: false });
  const manifest: ApplyManifest = { version: 1, id, createdAt: new Date().toISOString(), entries: [] };

  for (const item of prepared) {
    const existedBefore = item.operation.kind !== "create";
    const backupPath = existedBefore ? path.posix.join("files", item.operation.path) : null;
    if (backupPath) {
      const absoluteBackup = path.join(backupRoot, ...backupPath.split("/"));
      await mkdir(path.dirname(absoluteBackup), { recursive: true });
      await copyFile(item.absolutePath, absoluteBackup);
    }
    const afterHash = item.operation.kind === "delete" ? null : sha256(item.operation.content ?? "");
    manifest.entries.push({
      kind: item.operation.kind,
      path: item.operation.path,
      existedBefore,
      beforeHash: existedBefore ? sha256(item.before) : null,
      afterHash,
      backupPath,
    });
  }
  await writeManifest(root, manifest);

  const stateBefore = await loadState(root);
  const active = stateBefore.activeSnapshotId ? await loadSnapshot(root, stateBefore.activeSnapshotId) : null;

  try {
    for (const item of prepared) {
      if (item.operation.kind === "delete") {
        await unlink(item.absolutePath);
        continue;
      }
      await mkdir(path.dirname(item.absolutePath), { recursive: true });
      const temporary = path.join(path.dirname(item.absolutePath), `.contextbridge-${id}.tmp`);
      try {
        await writeFile(temporary, item.operation.content ?? "", { encoding: "utf8", flag: "wx" });
        if (item.mode !== undefined) await chmod(temporary, item.mode);
        await rename(temporary, item.absolutePath);
      } finally {
        await removeIfExists(temporary);
      }
    }
    const config = await loadConfig(root);
    const scan = await scanRepository(root, config);
    const snapshot = snapshotFromScan(scan, "apply", active?.task ?? "");
    await saveSnapshot(root, snapshot);
    await saveState(root, { ...stateBefore, activeSnapshotId: snapshot.id, lastApplyId: id });
  } catch (error) {
    try {
      await restoreFromManifest(root, manifest);
      await restoreStateBestEffort(root, stateBefore);
    } catch (rollbackError) {
      throw new Error(
        `Apply failed and rollback also failed. Original error: ${error instanceof Error ? error.message : String(error)}. ` +
        `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw new Error(`Apply failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { applied: true as const, id, operations, prepared, manifest };
}

export async function readApplyManifest(root: string, id: string): Promise<ApplyManifest> {
  const raw = await readFile(path.join(root, STATE_DIR, "backups", id, "manifest.json"), "utf8");
  return JSON.parse(raw) as ApplyManifest;
}

export async function undoLastApply(
  root: string,
  options: { yes: boolean; force: boolean; confirm?: (message: string) => Promise<boolean> },
) {
  const state = await loadState(root);
  if (!state.lastApplyId) throw new Error("There is no apply operation available to undo.");
  const manifest = await readApplyManifest(root, state.lastApplyId);
  if (manifest.undoneAt) throw new Error(`Apply ${manifest.id} has already been undone.`);

  const drifted: string[] = [];
  for (const entry of manifest.entries) {
    const target = await resolveSafeProjectPath(root, entry.path);
    const targetExists = await exists(target.absolute);
    if (entry.afterHash === null) {
      if (targetExists) drifted.push(entry.path);
    } else if (!targetExists || sha256(await readFile(target.absolute)) !== entry.afterHash) {
      drifted.push(entry.path);
    }
  }
  if (drifted.length > 0 && !options.force) {
    throw new Error(`Files changed after apply; refusing to overwrite them: ${drifted.join(", ")}. Use --force only after reviewing.`);
  }
  if (!options.yes) {
    if (!options.confirm) throw new Error("Confirmation is required to undo. Re-run interactively or pass --yes.");
    if (!(await options.confirm(`Undo ${manifest.entries.length} file operation(s)?`))) {
      return { undone: false as const, manifest, drifted };
    }
  }

  const active = state.activeSnapshotId ? await loadSnapshot(root, state.activeSnapshotId) : null;
  const manifestBefore = { ...manifest };
  const backupRoot = path.join(root, STATE_DIR, "backups", manifest.id);
  const rollbackRoot = await mkdtemp(path.join(backupRoot, "undo-rollback-"));
  const rollbackEntries: Array<{ path: string; existed: boolean; backupPath?: string }> = [];
  for (const entry of manifest.entries) {
    const target = await resolveSafeProjectPath(root, entry.path);
    const targetExists = await exists(target.absolute);
    const backupPath = targetExists ? path.posix.join("files", entry.path) : undefined;
    if (backupPath) {
      const backup = path.join(rollbackRoot, ...backupPath.split("/"));
      await mkdir(path.dirname(backup), { recursive: true });
      await copyFile(target.absolute, backup);
    }
    rollbackEntries.push({ path: entry.path, existed: targetExists, backupPath });
  }

  try {
    await restoreFromManifest(root, manifest);
    const config = await loadConfig(root);
    const scan = await scanRepository(root, config);
    const snapshot = snapshotFromScan(scan, "apply", active?.task ?? "");
    await saveSnapshot(root, snapshot);
    manifest.undoneAt = new Date().toISOString();
    await writeManifest(root, manifest);
    await saveState(root, { ...state, activeSnapshotId: snapshot.id, lastApplyId: null });
  } catch (error) {
    try {
      for (const entry of rollbackEntries) {
        const target = await resolveSafeProjectPath(root, entry.path);
        if (!entry.existed) {
          await removeIfExists(target.absolute);
          continue;
        }
        if (!entry.backupPath) throw new Error(`Missing undo rollback backup for ${entry.path}.`);
        await mkdir(path.dirname(target.absolute), { recursive: true });
        await copyFile(path.join(rollbackRoot, ...entry.backupPath.split("/")), target.absolute);
      }
      await writeManifest(root, manifestBefore);
      await restoreStateBestEffort(root, state);
    } catch (rollbackError) {
      throw new Error(
        `Undo failed and rollback also failed. Original error: ${error instanceof Error ? error.message : String(error)}. ` +
        `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw new Error(`Undo failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(rollbackRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  return { undone: true as const, manifest, drifted };
}
