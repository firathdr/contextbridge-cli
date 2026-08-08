import { z } from "zod";
import { normalizeRelativePath } from "./security.js";
import type { ChangeOperation } from "./types.js";

const OperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), path: z.string().min(1), content: z.string() }),
  z.object({ kind: z.literal("modify"), path: z.string().min(1), content: z.string() }),
  z.object({ kind: z.literal("delete"), path: z.string().min(1) }),
]);

function decodeXmlAttribute(value: string): string {
  if (/&(?!amp;|quot;|apos;|lt;|gt;)/.test(value)) throw new Error("Unsupported XML entity in change path.");
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function unwrapFence(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^```(?:xml)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function parseCdataSequence(value: string): string {
  const sections: string[] = [];
  const regex = /<!\[CDATA\[([\s\S]*?)\]\]>/gy;
  let cursor = 0;
  while (cursor < value.length) {
    regex.lastIndex = cursor;
    const match = regex.exec(value);
    if (!match) {
      if (/^\s*$/.test(value.slice(cursor))) break;
      throw new Error("Create/modify content must contain only CDATA sections.");
    }
    sections.push(match[1] ?? "");
    cursor = regex.lastIndex;
    const whitespace = value.slice(cursor).match(/^\s*/)?.[0] ?? "";
    cursor += whitespace.length;
  }
  if (sections.length === 0) throw new Error("Create/modify content requires CDATA.");
  return sections.join("");
}

export function parseChanges(input: string): ChangeOperation[] {
  const document = unwrapFence(input);
  const root = document.match(/^<contextbridge-changes\s+version="1"\s*>([\s\S]*)<\/contextbridge-changes>$/);
  if (!root) throw new Error("Clipboard must contain exactly one <contextbridge-changes version=\"1\"> envelope.");
  const body = root[1] ?? "";
  const operations: ChangeOperation[] = [];
  const operationPattern = /\s*(?:<(create|modify)\s+path="([^"]+)"\s*>((?:\s*<!\[CDATA\[[\s\S]*?\]\]>\s*)+)<\/\1\s*>|<delete\s+path="([^"]+)"\s*\/>)\s*/gy;
  let cursor = 0;
  while (cursor < body.length) {
    operationPattern.lastIndex = cursor;
    const match = operationPattern.exec(body);
    if (!match) {
      if (/^\s*$/.test(body.slice(cursor))) break;
      throw new Error(`Invalid change operation near character ${cursor}.`);
    }
    if (match[1] && match[2] !== undefined && match[3] !== undefined) {
      const kind = match[1] as "create" | "modify";
      const relativePath = normalizeRelativePath(decodeXmlAttribute(match[2]));
      operations.push(OperationSchema.parse({ kind, path: relativePath, content: parseCdataSequence(match[3].trim()) }));
    } else if (match[4] !== undefined) {
      const relativePath = normalizeRelativePath(decodeXmlAttribute(match[4]));
      operations.push(OperationSchema.parse({ kind: "delete", path: relativePath }));
    }
    cursor = operationPattern.lastIndex;
  }
  if (operations.length === 0) throw new Error("The change envelope contains no operations.");
  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.path)) throw new Error(`Duplicate operation for path: ${operation.path}`);
    seen.add(operation.path);
  }
  return operations;
}

