import { writeFile } from "node:fs/promises";
import path from "node:path";
import clipboard from "clipboardy";
import { STATE_DIR } from "./constants.js";

export interface PublishedOutput {
  path: string;
  copied: boolean;
  clipboardError?: string;
}

export async function publishOutput(
  root: string,
  kind: "handoff" | "sync",
  id: string,
  content: string,
  copy: boolean,
): Promise<PublishedOutput> {
  const outputPath = path.join(root, STATE_DIR, "outputs", `${kind}-${id}.md`);
  await writeFile(outputPath, content, "utf8");
  if (!copy) return { path: outputPath, copied: false };
  try {
    await clipboard.write(content);
    return { path: outputPath, copied: true };
  } catch (error) {
    return { path: outputPath, copied: false, clipboardError: error instanceof Error ? error.message : String(error) };
  }
}

