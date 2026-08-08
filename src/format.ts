import type { RankedFile } from "./relevance.js";
import type { ScanResult, ScannedFile, SkippedFile, Snapshot } from "./types.js";
import { countTokens } from "./tokenizer.js";

export function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

export function cdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function lineBudget(value: string, maxTokens: number): string {
  const lines: string[] = [];
  for (const line of value.split("\n")) {
    const candidate = [...lines, line].join("\n");
    if (countTokens(candidate) > maxTokens) {
      lines.push("… [truncated]");
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function repositoryMap(scan: ScanResult, ranked: RankedFile[], maxTokens: number): string {
  const rank = new Map(ranked.map((entry, index) => [entry.file.path, index]));
  const files = [...scan.files].sort((a, b) => (rank.get(a.path) ?? Infinity) - (rank.get(b.path) ?? Infinity));
  const lines: string[] = [];
  for (const file of files) {
    if (file.symbols.length === 0 && file.imports.length === 0) continue;
    const symbols = file.symbols.slice(0, 30).map((symbol) => `${symbol.exported ? "export " : ""}${symbol.kind} ${symbol.name}@${symbol.line}`);
    const imports = file.imports.slice(0, 20).map((item) => item.resolvedPath ?? item.source);
    const entry = `${file.path}\n  symbols: ${symbols.join(", ") || "-"}\n  imports: ${imports.join(", ") || "-"}`;
    if (countTokens([...lines, entry].join("\n")) > maxTokens) {
      lines.push("… [repository map truncated]");
      break;
    }
    lines.push(entry);
  }
  return lines.join("\n");
}

function fileBlock(file: ScannedFile, score?: number, reasons?: string[]): string {
  const relevance = score === undefined ? "" : ` relevance="${score.toFixed(2)}"`;
  const reasonText = reasons?.length ? ` reasons="${escapeXmlAttribute(reasons.slice(0, 5).join(", "))}"` : "";
  return `<file path="${escapeXmlAttribute(file.path)}" language="${escapeXmlAttribute(file.language)}" tokens="${file.tokenCount}"${relevance}${reasonText}>${cdata(file.content)}</file>`;
}

export function buildHandoffPackage(options: {
  scan: ScanResult;
  ranked: RankedFile[];
  snapshotId: string;
  task: string;
  tokenBudget: number;
}): { output: string; tokenCount: number; selected: RankedFile[]; omitted: RankedFile[] } {
  const { scan, ranked, snapshotId, task, tokenBudget } = options;
  const tree = lineBudget(scan.tree, Math.max(50, Math.floor(tokenBudget * 0.08)));
  const map = repositoryMap(scan, ranked, Math.max(100, Math.floor(tokenBudget * 0.15)));
  const opening = `<contextbridge version="1">
<metadata>
  <project>${escapeXmlText(scan.root.split(/[\\/]/).at(-1) ?? "project")}</project>
  <snapshot>${snapshotId}</snapshot>
  <task>${escapeXmlText(task)}</task>
  <generated>${new Date().toISOString()}</generated>
  <git-commit>${scan.git.commit ?? "unavailable"}</git-commit>
  <repository-files>${scan.files.length}</repository-files>
  <repository-tokens>${scan.totalTokens}</repository-tokens>
</metadata>
<repository-tree>${cdata(tree)}</repository-tree>
<repository-map>${cdata(map)}</repository-map>
<files>`;
  const closing = `</files>
<instructions>${cdata(`You are continuing an active coding task in an existing repository.
Do not assume files outside this package do not exist.
Use the repository map and dependency information before proposing edits.
Return repository edits as exactly one ContextBridge change envelope, with no second envelope:
<contextbridge-changes version="1">
  <modify path="relative/path"><![CDATA[complete replacement file content]]></modify>
  <create path="relative/path"><![CDATA[complete new file content]]></create>
  <delete path="relative/path" />
</contextbridge-changes>
For modify/create, always return the complete file content inside CDATA. Never use absolute paths or '..'.`)}</instructions>
</contextbridge>`;

  const selected: RankedFile[] = [];
  const omitted: RankedFile[] = [];
  let blocks = "";
  for (const entry of ranked) {
    if (entry.score <= 0 && selected.length > 0) {
      omitted.push(entry);
      continue;
    }
    const block = `\n${fileBlock(entry.file, entry.score, entry.reasons)}`;
    const candidate = `${opening}${blocks}${block}\n${closing}`;
    if (countTokens(candidate) <= tokenBudget) {
      blocks += block;
      selected.push(entry);
    } else {
      omitted.push(entry);
    }
  }
  const output = `${opening}${blocks}\n${closing}`;
  return { output, tokenCount: countTokens(output), selected, omitted };
}

export function buildSyncPackage(options: {
  base: Snapshot;
  nextId: string;
  scan: ScanResult;
  created: ScannedFile[];
  modified: ScannedFile[];
  deleted: string[];
  redacted: SkippedFile[];
}): { output: string; tokenCount: number } {
  const { base, nextId, scan, created, modified, deleted, redacted } = options;
  const renderFiles = (files: ScannedFile[]) => files.map((file) => fileBlock(file)).join("\n");
  const output = `<contextbridge-update version="1">
<base>${base.id}</base>
<snapshot>${nextId}</snapshot>
<task>${escapeXmlText(base.task)}</task>
<generated>${new Date().toISOString()}</generated>
<git-commit>${scan.git.commit ?? "unavailable"}</git-commit>
<created>
${renderFiles(created)}
</created>
<modified>
${renderFiles(modified)}
</modified>
<deleted>
${deleted.map((filePath) => `<file path="${escapeXmlAttribute(filePath)}" />`).join("\n")}
</deleted>
<redacted>
${redacted.map((file) => `<file path="${escapeXmlAttribute(file.path)}" reason="${escapeXmlAttribute(file.reason)}" />`).join("\n")}
</redacted>
<instructions>${cdata(`You already have project snapshot ${base.id}. Update your understanding using only this incremental package. The new baseline is ${nextId}. Return any requested edits in the strict ContextBridge change format from the original handoff.`)}</instructions>
</contextbridge-update>`;
  return { output, tokenCount: countTokens(output) };
}
