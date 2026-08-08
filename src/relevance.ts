import path from "node:path";
import type { ScanResult, ScannedFile } from "./types.js";

export interface RankedFile {
  file: ScannedFile;
  score: number;
  reasons: string[];
}

const STOP_WORDS = new Set([
  "a", "an", "and", "add", "change", "continue", "create", "fix", "for", "from", "implement",
  "in", "into", "of", "on", "or", "please", "the", "to", "update", "with", "ve", "bir", "bu",
  "icin", "için", "ekle", "devam", "et", "yap",
]);

const IMPORTANT_NAMES = new Set([
  "package.json", "tsconfig.json", "pyproject.toml", "requirements.txt", "cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "readme.md", "project.md", "dockerfile", "docker-compose.yml",
]);

function splitTerms(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9_$]+/)
    .filter((term) => term.length >= 2 && !STOP_WORDS.has(term));
}

function countOccurrences(haystack: string, needle: string, limit: number): number {
  let count = 0;
  let offset = 0;
  while (count < limit) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) break;
    count += 1;
    offset = found + needle.length;
  }
  return count;
}

export function rankFiles(scan: ScanResult, task: string, includeTests: boolean): RankedFile[] {
  const terms = [...new Set(splitTerms(task))];
  const scoreByPath = new Map<string, { score: number; reasons: Set<string> }>();
  const testsPattern = /(^|\/)(?:tests?|__tests__|spec)(\/|$)|\.(?:test|spec)\.[^.]+$/i;

  for (const file of scan.files) {
    let score = 0.2;
    const reasons = new Set<string>();
    const lowerPath = file.path.toLowerCase();
    const lowerContent = file.content.toLowerCase();
    const basename = path.posix.basename(lowerPath);

    if (IMPORTANT_NAMES.has(basename)) {
      score += 4;
      reasons.add("project metadata");
    }
    if (scan.git.dirty.has(file.path)) {
      score += 8;
      reasons.add("uncommitted change");
    }
    if (scan.git.recent.has(file.path)) {
      score += 2.5;
      reasons.add("recent Git history");
    }
    if (!includeTests && testsPattern.test(file.path)) score -= 4;

    for (const term of terms) {
      if (lowerPath.includes(term)) {
        score += basename.includes(term) ? 9 : 5;
        reasons.add(`path:${term}`);
      }
      const symbolHits = file.symbols.filter((symbol) => splitTerms(symbol.name).includes(term)).length;
      if (symbolHits > 0) {
        score += Math.min(10, symbolHits * 5);
        reasons.add(`symbol:${term}`);
      }
      const importHits = file.imports.filter((item) => item.source.toLowerCase().includes(term)).length;
      if (importHits > 0) {
        score += Math.min(5, importHits * 2);
        reasons.add(`import:${term}`);
      }
      const contentHits = countOccurrences(lowerContent, term, 5);
      if (contentHits > 0) {
        score += Math.min(4, contentHits * 0.8);
        reasons.add(`content:${term}`);
      }
    }
    if (terms.length === 0 && file.symbols.length > 0) score += 1;
    scoreByPath.set(file.path, { score, reasons });
  }

  // Propagate relevance through both imported dependencies and direct consumers.
  const baseScores = new Map([...scoreByPath].map(([key, value]) => [key, Math.max(0, value.score)]));
  for (const [filePath, baseScore] of baseScores) {
    if (baseScore < 2) continue;
    for (const dependency of scan.dependencies.get(filePath) ?? []) {
      const target = scoreByPath.get(dependency);
      if (target) {
        target.score += Math.min(6, baseScore * 0.22);
        target.reasons.add(`dependency of ${filePath}`);
      }
    }
    for (const consumer of scan.reverseDependencies.get(filePath) ?? []) {
      const target = scoreByPath.get(consumer);
      if (target) {
        target.score += Math.min(3, baseScore * 0.1);
        target.reasons.add(`uses ${filePath}`);
      }
    }
  }

  return scan.files
    .map((file) => {
      const ranking = scoreByPath.get(file.path)!;
      return { file, score: Math.max(0, ranking.score), reasons: [...ranking.reasons] };
    })
    .sort((a, b) => b.score - a.score || a.file.tokenCount - b.file.tokenCount || a.file.path.localeCompare(b.file.path));
}

