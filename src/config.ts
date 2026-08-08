import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_CONFIG, STATE_DIR } from "./constants.js";
import type { ContextBridgeConfig } from "./types.js";

const ConfigSchema = z.object({
  version: z.literal(1),
  context: z.object({
    tokenBudget: z.number().int().min(1_000).max(2_000_000),
    maxFileBytes: z.number().int().min(1_024).max(20_000_000),
    includeTests: z.boolean(),
    includeGitInfo: z.boolean(),
  }),
  security: z.object({ detectSecrets: z.boolean() }),
  ignore: z.array(z.string()),
});

export async function loadConfig(root: string): Promise<ContextBridgeConfig> {
  const configPath = path.join(root, STATE_DIR, "config.json");
  const raw = await readFile(configPath, "utf8");
  return ConfigSchema.parse(JSON.parse(raw));
}

export async function writeDefaultConfig(root: string): Promise<void> {
  const configPath = path.join(root, STATE_DIR, "config.json");
  await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx" });
}

