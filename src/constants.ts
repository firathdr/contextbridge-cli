import type { ContextBridgeConfig } from "./types.js";

export const STATE_DIR = ".contextbridge";

export const DEFAULT_CONFIG: ContextBridgeConfig = {
  version: 1,
  context: {
    tokenBudget: 60_000,
    maxFileBytes: 512_000,
    includeTests: false,
    includeGitInfo: true,
  },
  security: {
    detectSecrets: true,
  },
  ignore: [
    "node_modules/",
    "dist/",
    "build/",
    ".next/",
    "coverage/",
    "vendor/",
    "*.min.js",
    "*.map",
  ],
};

export const SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".cs", ".c", ".h",
  ".cpp", ".hpp", ".rb", ".php", ".swift", ".vue", ".svelte", ".sql",
  ".sh", ".bash", ".zsh",
]);

export const TEXT_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ".json", ".jsonc", ".md", ".mdx", ".txt", ".toml", ".yaml", ".yml",
  ".xml", ".html", ".css", ".scss", ".sass", ".less", ".graphql", ".gql",
  ".properties", ".ini", ".conf", ".config", ".csv", ".tsv", ".lock",
]);

export const RESOLVABLE_EXTENSIONS = [
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".py", ".go", ".rs", ".java", ".kt", ".cs",
];

