import { describe, expect, it } from "vitest";
import { parseChanges } from "../src/change-parser.js";
import { normalizeRelativePath } from "../src/security.js";

describe("strict ContextBridge change parser", () => {
  it("parses create, modify, delete, and split CDATA", () => {
    const operations = parseChanges(`
<contextbridge-changes version="1">
  <modify path="src/a&amp;b.ts"><![CDATA[const marker = "]]]]><![CDATA[>";]]></modify>
  <create path="src/new.ts"><![CDATA[export const ok = true;]]></create>
  <delete path="src/old.ts" />
</contextbridge-changes>`);
    expect(operations).toEqual([
      { kind: "modify", path: "src/a&b.ts", content: 'const marker = "]]>";' },
      { kind: "create", path: "src/new.ts", content: "export const ok = true;" },
      { kind: "delete", path: "src/old.ts" },
    ]);
  });

  it("rejects prose, duplicate targets, and traversal", () => {
    expect(() => parseChanges("Here are changes: <contextbridge-changes version=\"1\"></contextbridge-changes>")).toThrow();
    expect(() => parseChanges(`<contextbridge-changes version="1">
      <delete path="src/a.ts" /><delete path="src/a.ts" />
    </contextbridge-changes>`)).toThrow(/Duplicate/);
    expect(() => parseChanges(`<contextbridge-changes version="1">
      <delete path="../../outside" />
    </contextbridge-changes>`)).toThrow(/traversal/);
  });

  it("rejects absolute and state-directory paths", () => {
    expect(() => normalizeRelativePath("/tmp/file")).toThrow(/project-relative/);
    expect(() => normalizeRelativePath("C:\\Windows\\file")).toThrow(/project-relative/);
    expect(() => normalizeRelativePath(".contextbridge/config.json")).toThrow(/state/);
    expect(() => normalizeRelativePath(".git/config")).toThrow(/metadata/);
  });
});
