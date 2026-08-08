import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "./constants.js";
import { writeDefaultConfig } from "./config.js";

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(start = process.cwd()): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    if (await exists(path.join(current, STATE_DIR, "config.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("ContextBridge is not initialized. Run `cb init` in the project root.");
}

export async function initializeProject(root = process.cwd()): Promise<{ root: string; created: boolean }> {
  const resolvedRoot = path.resolve(root);
  const stateRoot = path.join(resolvedRoot, STATE_DIR);
  const configPath = path.join(stateRoot, "config.json");
  const alreadyInitialized = await exists(configPath);

  await mkdir(path.join(stateRoot, "snapshots"), { recursive: true });
  await mkdir(path.join(stateRoot, "backups"), { recursive: true });
  await mkdir(path.join(stateRoot, "outputs"), { recursive: true });

  if (!alreadyInitialized) {
    await writeDefaultConfig(resolvedRoot);
  }
  const statePath = path.join(stateRoot, "state.json");
  if (!(await exists(statePath))) {
    await writeFile(
      statePath,
      `${JSON.stringify({ version: 1, activeSnapshotId: null, lastApplyId: null, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { flag: "wx" },
    );
  }

  const gitignorePath = path.join(resolvedRoot, ".gitignore");
  let gitignore = "";
  if (await exists(gitignorePath)) gitignore = await readFile(gitignorePath, "utf8");
  const lines = gitignore.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(`${STATE_DIR}/`) && !lines.includes(STATE_DIR)) {
    const prefix = gitignore.length > 0 && !gitignore.endsWith("\n") ? "\n" : "";
    await writeFile(gitignorePath, `${gitignore}${prefix}${STATE_DIR}/\n`);
  }

  return { root: resolvedRoot, created: !alreadyInitialized };
}

export { exists };
