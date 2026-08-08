import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "./constants.js";
import { exists } from "./project.js";

const SECRET_BASENAMES = new Set([
  ".env", ".npmrc", ".pypirc", ".netrc", "credentials.json", "service-account.json",
  "serviceaccount.json", "secrets.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "known_hosts", "authorized_keys",
]);

const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

const SECRET_VALUE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[psoru]_[A-Za-z0-9]{30,255}\b/ },
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "credential URL", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@/]+@/i },
  {
    name: "assigned secret",
    pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\b\s*[:=]\s*["'`](?!\$\{|process\.env|import\.meta\.env)[^"'`\r\n]{12,}["'`]/i,
  },
];

export function secretFilenameReason(relativePath: string): string | null {
  const normalized = relativePath.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? normalized;
  if (parts.some((part) => part === ".ssh" || part === ".aws" || part === ".gnupg")) return "secret directory";
  if (SECRET_BASENAMES.has(basename)) return "secret filename";
  if (basename.startsWith(".env.")) return "environment file";
  if (/^(?:credentials|secrets?)(?:\.[^.]+)?$/i.test(basename)) return "credential filename";
  if (SECRET_EXTENSIONS.has(path.extname(basename))) return "private key/certificate container";
  return null;
}

export function detectSecretValue(content: string): string | null {
  for (const candidate of SECRET_VALUE_PATTERNS) {
    if (candidate.pattern.test(content)) return candidate.name;
  }
  return null;
}

export function normalizeRelativePath(input: string): string {
  if (input.includes("\0")) throw new Error("Paths may not contain NUL bytes.");
  const slashPath = input.replaceAll("\\", "/").trim();
  if (!slashPath || path.posix.isAbsolute(slashPath) || path.win32.isAbsolute(input)) {
    throw new Error(`Path must be project-relative: ${input}`);
  }
  const normalized = path.posix.normalize(slashPath);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Path traversal is not allowed: ${input}`);
  }
  if (normalized === STATE_DIR || normalized.startsWith(`${STATE_DIR}/`)) {
    throw new Error(`ContextBridge state cannot be modified through apply: ${input}`);
  }
  if ([".git", ".hg", ".svn"].some((directory) => normalized === directory || normalized.startsWith(`${directory}/`))) {
    throw new Error(`Version-control metadata cannot be modified through apply: ${input}`);
  }
  return normalized.replace(/^\.\//, "");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function resolveSafeProjectPath(root: string, input: string): Promise<{ relative: string; absolute: string }> {
  const relative = normalizeRelativePath(input);
  const absolute = path.resolve(root, ...relative.split("/"));
  if (!isInside(path.resolve(root), absolute)) throw new Error(`Path escapes project root: ${input}`);

  const realRoot = await realpath(root);
  let lexicalCursor = path.resolve(root);
  for (const part of relative.split("/")) {
    lexicalCursor = path.join(lexicalCursor, part);
    if (!(await exists(lexicalCursor))) break;
    if ((await lstat(lexicalCursor)).isSymbolicLink()) {
      throw new Error(`Symbolic-link paths are not allowed: ${input}`);
    }
  }

  let cursor = absolute;
  while (!(await exists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error(`Cannot resolve safe parent for: ${input}`);
    cursor = parent;
  }

  const stats = await lstat(cursor);
  if (stats.isSymbolicLink()) throw new Error(`Symbolic-link paths are not allowed: ${input}`);
  const realExisting = await realpath(cursor);
  if (!isInside(realRoot, realExisting)) throw new Error(`Path escapes project root through a link: ${input}`);

  return { relative, absolute };
}
