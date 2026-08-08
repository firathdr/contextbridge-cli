export type OperationKind = "create" | "modify" | "delete";

export interface ContextBridgeConfig {
  version: 1;
  context: {
    tokenBudget: number;
    maxFileBytes: number;
    includeTests: boolean;
    includeGitInfo: boolean;
  };
  security: {
    detectSecrets: boolean;
  };
  ignore: string[];
}

export interface CodeSymbol {
  name: string;
  kind: "function" | "class" | "method" | "interface" | "type" | "enum" | "variable";
  line: number;
  exported: boolean;
}

export interface ImportReference {
  source: string;
  names: string[];
  resolvedPath?: string;
}

export interface ScannedFile {
  path: string;
  absolutePath: string;
  size: number;
  hash: string;
  content: string;
  tokenCount: number;
  language: string;
  symbols: CodeSymbol[];
  imports: ImportReference[];
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface GitContext {
  available: boolean;
  commit: string | null;
  dirty: Set<string>;
  recent: Set<string>;
}

export interface ScanResult {
  root: string;
  files: ScannedFile[];
  skipped: SkippedFile[];
  tree: string;
  totalTokens: number;
  dependencies: Map<string, Set<string>>;
  reverseDependencies: Map<string, Set<string>>;
  git: GitContext;
}

export interface SnapshotFile {
  hash: string;
  size: number;
  tokens: number;
}

export interface Snapshot {
  version: 1;
  id: string;
  createdAt: string;
  reason: "handoff" | "sync" | "apply";
  task: string;
  gitCommit: string | null;
  totalTokens: number;
  files: Record<string, SnapshotFile>;
}

export interface ProjectState {
  version: 1;
  activeSnapshotId: string | null;
  lastApplyId: string | null;
  updatedAt: string;
}

export interface ChangeOperation {
  kind: OperationKind;
  path: string;
  content?: string;
}

export interface ApplyManifestEntry {
  kind: OperationKind;
  path: string;
  existedBefore: boolean;
  beforeHash: string | null;
  afterHash: string | null;
  backupPath: string | null;
}

export interface ApplyManifest {
  version: 1;
  id: string;
  createdAt: string;
  entries: ApplyManifestEntry[];
  undoneAt?: string;
}

