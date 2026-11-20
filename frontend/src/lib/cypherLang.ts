// Cypher support for CodeMirror 6: a StreamLanguage tokenizer, highlight style and autocomplete.

import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream } from "@codemirror/language";
import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";

export const CYPHER_KEYWORDS = [
  "MATCH", "OPTIONAL", "WHERE", "RETURN", "WITH", "UNWIND", "ORDER", "BY", "SKIP", "LIMIT", "DISTINCT",
  "AS", "AND", "OR", "XOR", "NOT", "IN", "IS", "NULL", "TRUE", "FALSE", "CASE", "WHEN", "THEN", "ELSE",
  "END", "CALL", "YIELD", "UNION", "ALL", "EXISTS", "COUNT", "STARTS", "ENDS", "CONTAINS", "ASC", "ASCENDING",
  "DESC", "DESCENDING", "USE", "SHOW", "EXPLAIN", "PROFILE", "COLLECT", "ANY", "NONE", "SINGLE",
  // write clauses are highlighted so users can see them (and the server rejects them)
  "CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE", "DROP", "FOREACH", "LOAD", "CSV",
];

export const CYPHER_FUNCTIONS = [
  "count", "collect", "sum", "avg", "min", "max", "size", "length", "nodes", "relationships", "labels",
  "type", "id", "elementId", "keys", "properties", "coalesce", "head", "last", "tail", "range", "toLower",
  "toUpper", "toString", "toInteger", "toFloat", "toBoolean", "trim", "split", "replace", "substring",
  "startNode", "endNode", "exists", "date", "datetime", "duration", "timestamp", "shortestPath",
  "allShortestPaths", "reduce", "reverse", "round", "abs", "percentileCont", "stDev",
];

const KEYWORD_SET = new Set(CYPHER_KEYWORDS);

interface State {
  inBlockComment: boolean;
  afterColon: boolean;
  afterDot: boolean;
  lastWasType: boolean;
}

function tokenString(stream: StringStream, quote: string): string {
  let escaped = false;
  let ch: string | void;
  while ((ch = stream.next()) != null) {
    if (ch === quote && !escaped) break;
    escaped = !escaped && ch === "\\" && quote !== "`";
  }
  return quote === "`" ? "variableName" : "string";
}

const cypherStream = StreamLanguage.define<State>({
  name: "cypher",
  startState: () => ({ inBlockComment: false, afterColon: false, afterDot: false, lastWasType: false }),
  token(stream, state) {
    const wasType = state.lastWasType;
    state.lastWasType = false;
    if (state.inBlockComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inBlockComment = false;
      } else stream.skipToEnd();
      return "comment";
    }
    if (stream.eatSpace()) {
      state.lastWasType = wasType;
      return null;
    }
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inBlockComment = true;
      return "comment";
    }
    if (stream.sol() && stream.peek() === ":" && stream.match(/^:[a-z]+/)) {
      return "meta";
    }
    const ch = stream.peek()!;
    if (ch === "'" || ch === '"' || ch === "`") {
      stream.next();
      const style = tokenString(stream, ch);
      if (state.afterColon) {
        state.afterColon = false;
        state.lastWasType = true;
        return "typeName";
      }
      return style;
    }
    if (stream.match(/^-?\d+(\.\d+)?([eE][-+]?\d+)?/)) return "number";
    if (stream.match(/^\$[A-Za-z_][\w]*/)) return "variableName.special";
    if (ch === ":") {
      stream.next();
      state.afterColon = true;
      return "punctuation";
    }
    if (ch === ".") {
      stream.next();
      state.afterDot = true;
      return "punctuation";
    }
    if (stream.match(/^[A-Za-z_][\w]*/)) {
      const word = stream.current();
      if (state.afterColon) {
        state.afterColon = false;
        state.lastWasType = true;
        return "typeName";
      }
      if (state.afterDot) {
        state.afterDot = false;
        return "propertyName";
      }
      if (KEYWORD_SET.has(word.toUpperCase())) return "keyword";
      // Known functions and procedure calls (anything followed by "(")
      if (stream.peek() === "(") return "variableName.function";
      return "variableName";
    }
    stream.next();
    // [:A|B] -> B is a relationship type too
    state.afterColon = ch === "|" && wasType;
    state.afterDot = false;
    if (/[-<>=+*/%^!]/.test(ch)) return "operator";
    if (/[()[\]{}]/.test(ch)) return "bracket";
    return "punctuation";
  },
  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
  },
});

export const cypherLanguage = cypherStream;

export const cypherHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.keyword, color: "#001689", fontWeight: "600" },
    { tag: t.typeName, color: "#9A6B00" },
    { tag: t.propertyName, color: "#007C88" },
    { tag: t.string, color: "#2E7D32" },
    { tag: t.number, color: "#C2410C" },
    { tag: t.comment, color: "#6B7280", fontStyle: "italic" },
    { tag: t.special(t.variableName), color: "#B42318" },
    { tag: t.function(t.variableName), color: "#0069C2" },
    { tag: t.variableName, color: "#111827" },
    { tag: t.operator, color: "#0069C2" },
    { tag: t.meta, color: "#8B3FC8", fontWeight: "600" },
    { tag: t.bracket, color: "#6B7280" },
  ]),
);

export interface SchemaVocab {
  labels: string[];
  relationshipTypes: string[];
  propertyKeys: string[];
}

function quoteIfNeeded(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "`" + name + "`";
}

/** Completion source using the schema loaded from /api/schema. */
export function cypherCompletions(getVocab: () => SchemaVocab) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const vocab = getVocab();
    // label / relationship type after ":"
    const colon = ctx.matchBefore(/:[A-Za-z_`][\w`]*$|:$/);
    if (colon) {
      const before = ctx.state.sliceDoc(Math.max(0, colon.from - 40), colon.from);
      // Rough check: inside [...] => relationship types first
      const inRel = before.lastIndexOf("[") > before.lastIndexOf("]") && before.lastIndexOf("[") > before.lastIndexOf("(");
      const opts: Completion[] = [
        ...vocab.labels.map((l) => ({ label: quoteIfNeeded(l), type: "type", detail: "label", boost: inRel ? -1 : 1 })),
        ...vocab.relationshipTypes.map((r) => ({
          label: quoteIfNeeded(r),
          type: "interface",
          detail: "relationship",
          boost: inRel ? 1 : -1,
        })),
      ];
      return { from: colon.from + 1, options: opts, validFor: /^[\w`]*$/ };
    }
    const dot = ctx.matchBefore(/\.[A-Za-z_]*$/);
    if (dot && !/\d\.$/.test(ctx.state.sliceDoc(dot.from - 1, dot.from + 1))) {
      return {
        from: dot.from + 1,
        options: vocab.propertyKeys.map((p) => ({ label: quoteIfNeeded(p), type: "property" })),
        validFor: /^\w*$/,
      };
    }
    const word = ctx.matchBefore(/[A-Za-z_][\w.]*$/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    return {
      from: word.from,
      options: [
        ...CYPHER_KEYWORDS.map((k) => ({ label: k, type: "keyword" })),
        ...CYPHER_FUNCTIONS.map((f) => ({ label: f, type: "function", apply: `${f}(` })),
        { label: "db.schema.visualization()", type: "function", detail: "procedure" },
        { label: "db.labels()", type: "function", detail: "procedure" },
        { label: "db.relationshipTypes()", type: "function", detail: "procedure" },
      ],
      validFor: /^[\w.]*$/,
    };
  };
}
