// Minimal ZIP reader (stored + deflate) so a skill can be imported from a .zip without
// any dependency. Returns text entries only; binary entries are reported and skipped.
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|ps1|rb|go|rs|java|kt|toml|ini|cfg|html?|css|scss|sql|xml|csv)$/i;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Read a zip archive.
 * @param {Buffer} buffer
 * @returns {{ files: Record<string,string>, skipped: {name: string, reason: string}[] }}
 */
export function readZip(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件（找不到目录结尾记录）");
  const total = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const files = {};
  const skipped = [];
  let pointer = centralOffset;

  for (let index = 0; index < total; index += 1) {
    if (pointer + 46 > buffer.length) break;
    if (buffer.readUInt32LE(pointer) !== CENTRAL_SIG) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength).replace(/\\/g, "/");
    pointer += 46 + nameLength + extraLength + commentLength;

    if (!name || name.endsWith("/")) continue;
    if (name.includes("..") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
      skipped.push({ name, reason: "路径越界" });
      continue;
    }
    if (!TEXT_EXT.test(name)) {
      skipped.push({ name, reason: "非文本资源" });
      continue;
    }
    if (uncompressedSize > 2 * 1024 * 1024) {
      skipped.push({ name, reason: "单文件超过 2MB" });
      continue;
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      skipped.push({ name, reason: "本地头损坏" });
      continue;
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);
    try {
      if (method === 0) files[name] = raw.toString("utf8");
      else if (method === 8) files[name] = inflateRawSync(raw).toString("utf8");
      else skipped.push({ name, reason: `不支持的压缩方式 ${method}` });
    } catch (error) {
      skipped.push({ name, reason: `解压失败：${String(error?.message || error)}` });
    }
  }

  return { files, skipped };
}

/** Drop a single wrapping directory (`repo-main/…`) so the bundle lands at the root. */
export function stripCommonPrefix(files) {
  const names = Object.keys(files);
  if (names.length === 0) return files;
  const firstSegments = new Set(names.map((name) => name.split("/")[0]));
  if (firstSegments.size !== 1) return files;
  const prefix = `${[...firstSegments][0]}/`;
  if (!names.every((name) => name.startsWith(prefix))) return files;
  const out = {};
  for (const [name, content] of Object.entries(files)) out[name.slice(prefix.length)] = content;
  return out;
}

/** Locate the directory that holds SKILL.md inside a flat file map. */
export function locateSkillRoot(files) {
  const entry = Object.keys(files).find((name) => name === "SKILL.md" || name.endsWith("/SKILL.md"));
  if (!entry) return null;
  return entry === "SKILL.md" ? "" : entry.slice(0, -"/SKILL.md".length);
}
