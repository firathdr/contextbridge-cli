import path from "node:path";
import { RESOLVABLE_EXTENSIONS } from "./constants.js";
import type { ScannedFile } from "./types.js";

function resolveImport(importer: string, source: string, known: Set<string>): string | undefined {
  if (!source.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), source));
  const candidates = [
    base,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => known.has(candidate));
}

export function buildDependencyGraph(files: ScannedFile[]): {
  dependencies: Map<string, Set<string>>;
  reverseDependencies: Map<string, Set<string>>;
} {
  const known = new Set(files.map((file) => file.path));
  const dependencies = new Map<string, Set<string>>();
  const reverseDependencies = new Map<string, Set<string>>();
  for (const file of files) {
    const targets = new Set<string>();
    for (const importRef of file.imports) {
      const resolved = resolveImport(file.path, importRef.source, known);
      if (!resolved) continue;
      importRef.resolvedPath = resolved;
      targets.add(resolved);
      const reverse = reverseDependencies.get(resolved) ?? new Set<string>();
      reverse.add(file.path);
      reverseDependencies.set(resolved, reverse);
    }
    dependencies.set(file.path, targets);
    reverseDependencies.set(file.path, reverseDependencies.get(file.path) ?? new Set());
  }
  return { dependencies, reverseDependencies };
}

