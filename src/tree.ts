interface TreeNode {
  files: Set<string>;
  children: Map<string, TreeNode>;
}

function createNode(): TreeNode {
  return { files: new Set(), children: new Map() };
}

export function buildRepositoryTree(paths: string[]): string {
  const root = createNode();
  for (const filePath of [...paths].sort()) {
    const parts = filePath.split("/");
    const file = parts.pop();
    if (!file) continue;
    let node = root;
    for (const part of parts) {
      let child = node.children.get(part);
      if (!child) {
        child = createNode();
        node.children.set(part, child);
      }
      node = child;
    }
    node.files.add(file);
  }

  const lines: string[] = ["."];
  const render = (node: TreeNode, prefix: string): void => {
    const entries = [
      ...[...node.children.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => ({ name, child })),
      ...[...node.files].sort().map((name) => ({ name, child: null })),
    ];
    entries.forEach((entry, index) => {
      const last = index === entries.length - 1;
      lines.push(`${prefix}${last ? "└──" : "├──"} ${entry.name}${entry.child ? "/" : ""}`);
      if (entry.child) render(entry.child, `${prefix}${last ? "    " : "│   "}`);
    });
  };
  render(root, "");
  return lines.join("\n");
}

