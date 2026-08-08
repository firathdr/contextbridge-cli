import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import createIgnore from "ignore";
import { SOURCE_EXTENSIONS, STATE_DIR, TEXT_EXTENSIONS } from "./constants.js";
import { analyzeCode } from "./analyzer.js";
import { buildDependencyGraph } from "./dependencies.js";
import { collectGitContext } from "./git.js";
import { exists } from "./project.js";
import { detectSecretValue, secretFilenameReason } from "./security.js";
import { countTokens } from "./tokenizer.js";
import { buildRepositoryTree } from "./tree.js";
import type { ContextBridgeConfig, ScanResult, ScannedFile, SkippedFile } from "./types.js";

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function appearsBinary(buffer: Buffer, extension: string): boolean {
  if (TEXT_EXTENSIONS.has(extension)) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.1;
}

async function addIgnoreFile(ignoreFilter: ReturnType<typeof createIgnore>, filePath: string): Promise<void> {
  if (await exists(filePath)) ignoreFilter.add(await readFile(filePath, "utf8"));
}

export async function scanRepository(root: string, config: ContextBridgeConfig): Promise<ScanResult> {
  const ignoreFilter = createIgnore();
  ignoreFilter.add([`${STATE_DIR}/`, ".git/", ...config.ignore]);
  await addIgnoreFile(ignoreFilter, path.join(root, ".gitignore"));
  await addIgnoreFile(ignoreFilter, path.join(root, ".contextbridgeignore"));

  const candidates = await fg("**/*", {
    cwd: root,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
    suppressErrors: true,
    ignore: [
      "**/.git/**",
      "**/.contextbridge/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/coverage/**",
      "**/vendor/**",
    ],
  });
  const files: ScannedFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const rawPath of candidates.sort()) {
    const relativePath = rawPath.replaceAll("\\", "/");
    if (ignoreFilter.ignores(relativePath)) continue;
    const filenameReason = secretFilenameReason(relativePath);
    if (filenameReason) {
      skipped.push({ path: relativePath, reason: filenameReason });
      continue;
    }
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      skipped.push({ path: relativePath, reason: "symbolic link" });
      continue;
    }
    if (stats.size > config.context.maxFileBytes) {
      skipped.push({ path: relativePath, reason: `larger than ${config.context.maxFileBytes} bytes` });
      continue;
    }
    const buffer = await readFile(absolutePath);
    const extension = path.extname(relativePath).toLowerCase();
    if (appearsBinary(buffer, extension)) {
      skipped.push({ path: relativePath, reason: "binary file" });
      continue;
    }
    const content = buffer.toString("utf8");
    if (config.security.detectSecrets) {
      const secretReason = detectSecretValue(content);
      if (secretReason) {
        skipped.push({ path: relativePath, reason: `potential ${secretReason}` });
        continue;
      }
    }
    const analysis = SOURCE_EXTENSIONS.has(extension)
      ? analyzeCode(relativePath, content)
      : { language: extension.slice(1) || "text", symbols: [], imports: [] };
    files.push({
      path: relativePath,
      absolutePath,
      size: buffer.byteLength,
      hash: sha256(buffer),
      content,
      tokenCount: countTokens(content),
      ...analysis,
    });
  }

  const { dependencies, reverseDependencies } = buildDependencyGraph(files);
  const git = await collectGitContext(root, config.context.includeGitInfo);
  return {
    root,
    files,
    skipped,
    tree: buildRepositoryTree(files.map((file) => file.path)),
    totalTokens: files.reduce((sum, file) => sum + file.tokenCount, 0),
    dependencies,
    reverseDependencies,
    git,
  };
}
