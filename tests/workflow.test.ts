import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyChangeDocument, prepareChanges, undoLastApply } from "../src/apply.js";
import { createHandoff } from "../src/handoff.js";
import { initializeProject } from "../src/project.js";
import { loadState } from "../src/state.js";
import { createSync } from "../src/sync.js";
import * as scannerModule from "../src/scanner.js";

const roots: string[] = [];

async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "contextbridge-flow-"));
  roots.push(root);
  await initializeProject(root);
  await writeFile(path.join(root, "app.ts"), "export const value = 1;\n");
  await writeFile(path.join(root, "old.ts"), "export const old = true;\n");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("handoff, sync, apply, and undo workflow", () => {
  it("creates an incremental sync and advances its baseline", async () => {
    const root = await project();
    const handoff = await createHandoff(root, "change app value", { budget: 5_000, copy: false });
    expect(handoff.output).toContain("<contextbridge version=\"1\">");
    expect(handoff.output).toContain("app.ts");
    expect(handoff.tokenCount).toBeLessThanOrEqual(5_000);
    await writeFile(path.join(root, "app.ts"), "export const value = 2;\n");
    await writeFile(path.join(root, "new.ts"), "export const added = true;\n");

    const sync = await createSync(root, { copy: false });
    expect(sync.changed).toBe(true);
    if (!sync.changed) throw new Error("Expected changes");
    expect(sync.modified.map((file) => file.path)).toEqual(["app.ts"]);
    expect(sync.created.map((file) => file.path)).toEqual(["new.ts"]);
    expect(sync.output).toContain("<contextbridge-update version=\"1\">");
    expect((await createSync(root, { copy: false })).changed).toBe(false);
  });

  it("does not advance the sync baseline when the update exceeds its token budget", async () => {
    const root = await project();
    await createHandoff(root, "change app value", { budget: 5_000, copy: false });
    const baseline = (await loadState(root)).activeSnapshotId;
    await writeFile(path.join(root, "app.ts"), `export const value = ${JSON.stringify("value ".repeat(2_000))};\n`);

    await expect(createSync(root, { copy: false, budget: 1_000 })).rejects.toThrow(/exceeding the 1000 token budget/);
    expect((await loadState(root)).activeSnapshotId).toBe(baseline);
    expect((await createSync(root, { copy: false, budget: 10_000 })).changed).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("rejects case-insensitive target collisions on Windows", async () => {
    const root = await project();
    await expect(prepareChanges(root, [
      { kind: "modify", path: "app.ts", content: "first\n" },
      { kind: "modify", path: "APP.ts", content: "second\n" },
    ])).rejects.toThrow(/same target/);
  });

  it("applies complete files, records a backup, and undoes the operation", async () => {
    const root = await project();
    await createHandoff(root, "change files", { budget: 5_000, copy: false });
    const document = `<contextbridge-changes version="1">
      <modify path="app.ts"><![CDATA[export const value = 3;\n]]></modify>
      <create path="created.ts"><![CDATA[export const created = true;\n]]></create>
      <delete path="old.ts" />
    </contextbridge-changes>`;
    const applied = await applyChangeDocument(root, document, { yes: true });
    expect(applied.applied).toBe(true);
    expect(await readFile(path.join(root, "app.ts"), "utf8")).toBe("export const value = 3;\n");
    expect(await readFile(path.join(root, "created.ts"), "utf8")).toBe("export const created = true;\n");
    await expect(readFile(path.join(root, "old.ts"), "utf8")).rejects.toThrow();
    expect((await loadState(root)).lastApplyId).toBe(applied.applied ? applied.id : null);

    const undone = await undoLastApply(root, { yes: true, force: false });
    expect(undone.undone).toBe(true);
    expect(await readFile(path.join(root, "app.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(await readFile(path.join(root, "old.ts"), "utf8")).toBe("export const old = true;\n");
    await expect(readFile(path.join(root, "created.ts"), "utf8")).rejects.toThrow();
    expect((await loadState(root)).lastApplyId).toBeNull();
  });

  it("rolls file changes back when the post-apply snapshot cannot be created", async () => {
    const root = await project();
    const stateBefore = await loadState(root);
    const scan = vi.spyOn(scannerModule, "scanRepository").mockRejectedValueOnce(new Error("injected scan failure"));
    const document = `<contextbridge-changes version="1">
      <modify path="app.ts"><![CDATA[export const value = 8;\n]]></modify>
    </contextbridge-changes>`;

    try {
      await expect(applyChangeDocument(root, document, { yes: true })).rejects.toThrow(/was rolled back/);
    } finally {
      scan.mockRestore();
    }

    expect(await readFile(path.join(root, "app.ts"), "utf8")).toBe("export const value = 1;\n");
    const stateAfter = await loadState(root);
    expect(stateAfter.activeSnapshotId).toBe(stateBefore.activeSnapshotId);
    expect(stateAfter.lastApplyId).toBeNull();
  });

  it("restores the applied state when undo snapshot creation fails", async () => {
    const root = await project();
    const document = `<contextbridge-changes version="1">
      <modify path="app.ts"><![CDATA[export const value = 9;\n]]></modify>
      <create path="created.ts"><![CDATA[export const created = true;\n]]></create>
      <delete path="old.ts" />
    </contextbridge-changes>`;
    const applied = await applyChangeDocument(root, document, { yes: true });
    if (!applied.applied) throw new Error("Expected apply to succeed");
    const stateBefore = await loadState(root);
    const scan = vi.spyOn(scannerModule, "scanRepository").mockRejectedValueOnce(new Error("injected scan failure"));

    try {
      await expect(undoLastApply(root, { yes: true, force: false })).rejects.toThrow(/was rolled back/);
    } finally {
      scan.mockRestore();
    }

    expect(await readFile(path.join(root, "app.ts"), "utf8")).toBe("export const value = 9;\n");
    expect(await readFile(path.join(root, "created.ts"), "utf8")).toBe("export const created = true;\n");
    await expect(readFile(path.join(root, "old.ts"), "utf8")).rejects.toThrow();
    const stateAfter = await loadState(root);
    expect(stateAfter.activeSnapshotId).toBe(stateBefore.activeSnapshotId);
    expect(stateAfter.lastApplyId).toBe(applied.id);
  });

  it("refuses undo when a file drifted after apply", async () => {
    const root = await project();
    const document = `<contextbridge-changes version="1">
      <modify path="app.ts"><![CDATA[export const value = 4;\n]]></modify>
    </contextbridge-changes>`;
    await applyChangeDocument(root, document, { yes: true });
    await writeFile(path.join(root, "app.ts"), "export const value = 99;\n");
    await expect(undoLastApply(root, { yes: true, force: false })).rejects.toThrow(/changed after apply/);
  });
});
