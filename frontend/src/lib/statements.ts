// Splitting editor input into statements and handling client commands (:param, :clear ...).

/** Split on `;` that are not inside strings, back-ticks or comments. */
export function splitStatements(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    const nx = input[i + 1];
    if (ch === "/" && nx === "/") {
      const j = input.indexOf("\n", i);
      const end = j === -1 ? n : j;
      cur += input.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && nx === "*") {
      const j = input.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      cur += input.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (input[j] === "\\" && ch !== "`") {
          j += 2;
          continue;
        }
        if (input[j] === ch) break;
        j++;
      }
      cur += input.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === ";") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    // Client commands (":param x => 1") end at the newline.
    if (ch === "\n" && cur.trim().startsWith(":")) {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0 && !/^(\/\/[^\n]*\s*)+$/.test(s));
}

/** Parse a Cypher-ish literal (JSON, single-quoted strings, numbers, booleans, maps with bare keys). */
export function parseLiteral(src: string): unknown {
  const s = src.trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  if (/^'.*'$/s.test(s)) return s.slice(1, -1).replace(/\\'/g, "'");
  // Convert a Cypher map/list literal to JSON: quote bare keys, swap single quotes.
  const json = s
    .replace(/'((?:[^'\\]|\\.)*)'/g, (_m, g: string) => JSON.stringify(g.replace(/\\'/g, "'")))
    .replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(json);
  } catch {
    return s;
  }
}

export type ClientCommand =
  | { kind: "param"; name: string; value: unknown }
  | { kind: "params"; value?: Record<string, unknown> }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "unknown"; text: string };

export function parseCommand(stmt: string): ClientCommand | null {
  const s = stmt.trim();
  if (!s.startsWith(":")) return null;
  let m = /^:param\s+([A-Za-z_][\w]*)\s*(?:=>|:)\s*([\s\S]+)$/.exec(s);
  if (m) return { kind: "param", name: m[1], value: parseLiteral(m[2]) };
  m = /^:params?\s*(\{[\s\S]*\})\s*$/.exec(s);
  if (m) {
    const v = parseLiteral(m[1]);
    if (v && typeof v === "object" && !Array.isArray(v)) return { kind: "params", value: v as Record<string, unknown> };
  }
  if (/^:params?$/.test(s)) return { kind: "params" };
  if (/^:clear$/.test(s)) return { kind: "clear" };
  if (/^:help$/.test(s)) return { kind: "help" };
  return { kind: "unknown", text: s };
}
