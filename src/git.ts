import { simpleGit } from "simple-git";
import type { GitContext } from "./types.js";

function normalizeGitPath(value: string): string {
  return value.replaceAll("\\", "/").trim();
}

export async function collectGitContext(root: string, enabled: boolean): Promise<GitContext> {
  const empty: GitContext = { available: false, commit: null, dirty: new Set(), recent: new Set() };
  if (!enabled) return empty;
  try {
    const git = simpleGit({ baseDir: root });
    if (!(await git.checkIsRepo())) return empty;
    const [status, commit, recentRaw] = await Promise.all([
      git.status(),
      git.revparse(["--short", "HEAD"]).catch(() => null),
      git.raw(["log", "-n", "8", "--name-only", "--pretty=format:"]).catch(() => ""),
    ]);
    const dirty = new Set<string>();
    for (const file of status.files) {
      dirty.add(normalizeGitPath(file.path));
      if (file.from) dirty.add(normalizeGitPath(file.from));
    }
    const recent = new Set<string>(
      String(recentRaw).split(/\r?\n/).map(normalizeGitPath).filter(Boolean),
    );
    return { available: true, commit: commit?.trim() || null, dirty, recent };
  } catch {
    return empty;
  }
}
