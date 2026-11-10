// Minimal YAML frontmatter reader for SKILL.md files (no dependency on a YAML library).
// Supports plain scalars, quoted scalars, inline lists and block lists.

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    if ((first === '"' && v.endsWith('"')) || (first === "'" && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
  }
  return v;
}

function scalar(value) {
  const v = unquote(value);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => unquote(part));
  }
  return v;
}

function coerceBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(v)) return true;
  if (["false", "no", "off", "0"].includes(v)) return false;
  return undefined;
}

export function parseFrontmatter(text) {
  const src = String(text ?? "");
  if (!src.startsWith("---")) return { data: {}, body: src };
  const end = src.indexOf("\n---", 3);
  if (end < 0) return { data: {}, body: src };
  const block = src.slice(3, end);
  const body = src.slice(end + 4).replace(/^\r?\n/, "");
  const data = {};
  let listKey = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listItem = /^\s*-\s+(.*)$/.exec(line);
    if (listItem && listKey) {
      const current = Array.isArray(data[listKey]) ? data[listKey] : [];
      current.push(scalar(listItem[1]));
      data[listKey] = current;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const raw = m[2];
    if (raw.trim() === "") {
      listKey = key;
      data[key] = [];
    } else {
      listKey = null;
      data[key] = scalar(raw);
    }
  }
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length === 0) data[key] = value;
  }
  return { data, body };
}

export function skillMetaFromText(text, fallbackName) {
  const { data } = parseFrontmatter(text);
  const name = String(data.name || fallbackName || "").trim();
  const description = String(data.description || "").trim();
  const whenToUse = String(data.whenToUse || data.when_to_use || "").trim();
  return {
    name,
    description,
    whenToUse,
    disableModelInvocation: coerceBool(data["disable-model-invocation"] ?? data["disableModelInvocation"]),
    userInvocable: coerceBool(data["user-invocable"] ?? data["userInvocable"]),
    metadata: typeof data.metadata === "object" ? data.metadata : undefined,
  };
}

export function kebab(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
