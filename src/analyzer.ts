import path from "node:path";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScriptLanguages from "tree-sitter-typescript";
import type { CodeSymbol, ImportReference } from "./types.js";

interface AnalysisResult {
  language: string;
  symbols: CodeSymbol[];
  imports: ImportReference[];
}

const JS_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function isExported(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "export_statement") return true;
    if (current.type === "program") return false;
    current = current.parent;
  }
  return false;
}

function nodeName(node: Parser.SyntaxNode): string | null {
  return node.childForFieldName("name")?.text ?? null;
}

function analyzeTreeSitter(content: string, extension: string): AnalysisResult {
  const parser = new Parser();
  const language = TS_EXTENSIONS.has(extension)
    ? extension === ".tsx" ? TypeScriptLanguages.tsx : TypeScriptLanguages.typescript
    : JavaScript;
  parser.setLanguage(language as Parameters<Parser["setLanguage"]>[0]);
  const tree = parser.parse(content);
  const symbols: CodeSymbol[] = [];
  const imports: ImportReference[] = [];
  const seenSymbols = new Set<string>();
  const seenImports = new Set<string>();

  const addSymbol = (node: Parser.SyntaxNode, kind: CodeSymbol["kind"], name = nodeName(node)): void => {
    if (!name) return;
    const key = `${kind}:${name}:${node.startPosition.row}`;
    if (seenSymbols.has(key)) return;
    seenSymbols.add(key);
    symbols.push({ name, kind, line: node.startPosition.row + 1, exported: isExported(node) });
  };

  const addImport = (source: string, names: string[] = []): void => {
    const cleanSource = unquote(source.trim());
    if (!cleanSource) return;
    const key = `${cleanSource}:${names.join(",")}`;
    if (seenImports.has(key)) return;
    seenImports.add(key);
    imports.push({ source: cleanSource, names });
  };

  const visit = (node: Parser.SyntaxNode): void => {
    switch (node.type) {
      case "function_declaration": addSymbol(node, "function"); break;
      case "class_declaration": addSymbol(node, "class"); break;
      case "method_definition": addSymbol(node, "method"); break;
      case "interface_declaration": addSymbol(node, "interface"); break;
      case "type_alias_declaration": addSymbol(node, "type"); break;
      case "enum_declaration": addSymbol(node, "enum"); break;
      case "lexical_declaration":
      case "variable_declaration": {
        if (node.parent?.type === "program" || node.parent?.type === "export_statement") {
          for (const child of node.namedChildren) {
            if (child.type !== "variable_declarator") continue;
            const value = child.childForFieldName("value");
            if (value && ["arrow_function", "function_expression"].includes(value.type)) {
              addSymbol(child, "function", child.childForFieldName("name")?.text ?? null);
            } else if (isExported(child)) {
              addSymbol(child, "variable", child.childForFieldName("name")?.text ?? null);
            }
          }
        }
        break;
      }
      case "import_statement": {
        const source = node.childForFieldName("source");
        if (source) {
          const names = node.namedChildren
            .filter((child) => ["import_clause", "named_imports", "namespace_import"].includes(child.type))
            .flatMap((child) => child.text.match(/[A-Za-z_$][\w$]*/g) ?? [])
            .filter((name) => !["import", "from", "as", "type"].includes(name));
          addImport(source.text, names);
        }
        break;
      }
      case "export_statement": {
        const source = node.childForFieldName("source");
        if (source) addImport(source.text);
        break;
      }
      case "call_expression": {
        const fn = node.childForFieldName("function");
        const args = node.childForFieldName("arguments");
        if (fn?.text === "require" && args?.namedChildCount === 1) {
          const first = args.namedChild(0);
          if (first?.type === "string") addImport(first.text);
        }
        break;
      }
    }
    for (const child of node.namedChildren) visit(child);
  };

  visit(tree.rootNode);
  return { language: TS_EXTENSIONS.has(extension) ? "typescript" : "javascript", symbols, imports };
}

function fallbackAnalysis(content: string, extension: string): AnalysisResult {
  const symbols: CodeSymbol[] = [];
  const imports: ImportReference[] = [];
  const lines = content.split(/\r?\n/);
  const definitions = [
    { pattern: /^\s*(?:export\s+)?(?:async\s+)?(?:def|function|fn|func)\s+([A-Za-z_$][\w$]*)/, kind: "function" as const },
    { pattern: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" as const },
    { pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" as const },
    { pattern: /^\s*(?:export\s+)?(?:type|struct)\s+([A-Za-z_$][\w$]*)/, kind: "type" as const },
  ];
  lines.forEach((line, index) => {
    for (const definition of definitions) {
      const match = line.match(definition.pattern);
      if (match?.[1]) {
        symbols.push({ name: match[1], kind: definition.kind, line: index + 1, exported: /\bexport\b/.test(line) });
        break;
      }
    }
  });

  if (extension === ".py") {
    for (const match of content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      imports.push({ source: match[1] ?? match[2] ?? "", names: [] });
    }
  }
  return { language: extension.slice(1) || "text", symbols, imports };
}

export function analyzeCode(filePath: string, content: string): AnalysisResult {
  const extension = path.extname(filePath).toLowerCase();
  if (JS_EXTENSIONS.has(extension) || TS_EXTENSIONS.has(extension)) {
    try {
      return analyzeTreeSitter(content, extension);
    } catch {
      return fallbackAnalysis(content, extension);
    }
  }
  return fallbackAnalysis(content, extension);
}
