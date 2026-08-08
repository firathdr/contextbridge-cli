import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { initializeProject } from "../src/project.js";
import { scanRepository } from "../src/scanner.js";
import { resolveSafeProjectPath } from "../src/security.js";

const temporaryRoots: string[] = [];

async function tempProject(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "contextbridge-scan-"));
  temporaryRoots.push(root);
  await initializeProject(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repository scanner", () => {
  it("respects ignore rules, excludes secrets, and extracts symbols/dependencies", async () => {
    const root = await tempProject();
    await writeFile(path.join(root, ".gitignore"), "ignored.ts\n.contextbridge/\n");
    await writeFile(path.join(root, "ignored.ts"), "export const ignored = true;");
    await writeFile(path.join(root, ".env"), "TOKEN=secret");
    await writeFile(path.join(root, "leak.ts"), `const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";`);
    await writeFile(path.join(root, "dep.ts"), "export interface User { id: string }\n");
    await writeFile(path.join(root, "main.ts"), `import type { User } from "./dep";\nexport function load(user: User) { return user.id; }\n`);
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));

    const scan = await scanRepository(root, await loadConfig(root));
    expect(scan.files.map((file) => file.path)).toEqual(expect.arrayContaining(["main.ts", "dep.ts", ".gitignore"]));
    expect(scan.files.map((file) => file.path)).not.toEqual(expect.arrayContaining(["ignored.ts", ".env", "leak.ts", "binary.bin"]));
    expect(scan.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: ".env" }),
      expect.objectContaining({ path: "leak.ts" }),
      expect.objectContaining({ path: "binary.bin" }),
    ]));
    expect(scan.files.find((file) => file.path === "main.ts")?.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "load", kind: "function", exported: true }),
    ]));
    expect(scan.dependencies.get("main.ts")).toEqual(new Set(["dep.ts"]));
  });

  it("rejects paths that traverse a symlink", async () => {
    const root = await tempProject();
    const outside = await mkdtemp(path.join(os.tmpdir(), "contextbridge-outside-"));
    temporaryRoots.push(outside);
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveSafeProjectPath(root, "linked/file.ts")).rejects.toThrow(/Symbolic-link/);
    const scan = await scanRepository(root, await loadConfig(root));
    expect(scan.files.map((file) => file.path)).not.toContain("linked/file.ts");
  });

  it("skips oversized files using their metadata", async () => {
    const root = await tempProject();
    await writeFile(path.join(root, "large.txt"), "x".repeat(2_048));
    const config = await loadConfig(root);
    config.context.maxFileBytes = 1_024;

    const scan = await scanRepository(root, config);

    expect(scan.files.map((file) => file.path)).not.toContain("large.txt");
    expect(scan.skipped).toContainEqual({ path: "large.txt", reason: "larger than 1024 bytes" });
  });
});
