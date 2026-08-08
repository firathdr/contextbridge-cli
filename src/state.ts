import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { STATE_DIR } from "./constants.js";
import type { ProjectState, ScanResult, Snapshot } from "./types.js";

const StateSchema = z.object({
  version: z.literal(1),
  activeSnapshotId: z.string().nullable(),
  lastApplyId: z.string().nullable(),
  updatedAt: z.string(),
});

const SnapshotSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  createdAt: z.string(),
  reason: z.enum(["handoff", "sync", "apply"]),
  task: z.string(),
  gitCommit: z.string().nullable(),
  totalTokens: z.number(),
  files: z.record(z.string(), z.object({ hash: z.string(), size: z.number(), tokens: z.number() })),
});

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export function createStateId(prefix: "cb" | "apply"): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export async function loadState(root: string): Promise<ProjectState> {
  const raw = await readFile(path.join(root, STATE_DIR, "state.json"), "utf8");
  return StateSchema.parse(JSON.parse(raw));
}

export async function saveState(root: string, state: ProjectState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path.join(root, STATE_DIR, "state.json"), state);
}

export function snapshotFromScan(
  scan: ScanResult,
  reason: Snapshot["reason"],
  task: string,
  id = createStateId("cb"),
): Snapshot {
  return {
    version: 1,
    id,
    createdAt: new Date().toISOString(),
    reason,
    task,
    gitCommit: scan.git.commit,
    totalTokens: scan.totalTokens,
    files: Object.fromEntries(
      scan.files.map((file) => [file.path, { hash: file.hash, size: file.size, tokens: file.tokenCount }]),
    ),
  };
}

export async function saveSnapshot(root: string, snapshot: Snapshot): Promise<void> {
  await writeJsonAtomic(path.join(root, STATE_DIR, "snapshots", `${snapshot.id}.json`), snapshot);
}

export async function loadSnapshot(root: string, id: string): Promise<Snapshot> {
  const raw = await readFile(path.join(root, STATE_DIR, "snapshots", `${id}.json`), "utf8");
  return SnapshotSchema.parse(JSON.parse(raw));
}

export async function activateSnapshot(root: string, snapshot: Snapshot): Promise<void> {
  await saveSnapshot(root, snapshot);
  const state = await loadState(root);
  state.activeSnapshotId = snapshot.id;
  await saveState(root, state);
}

