// Resolve and import plugin packages that ship inside the DeepSeek Harness installation
// (they live in app.asar, so they are not resolvable from this bundle's own node_modules).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const ENTRY = "lib/index.js";

// Packages this bundle mounts at runtime.
export const SHIPPED = {
  mcpClient: "@deepseek-ai/dsh-mcp-client",
  skillFilesystem: "@deepseek-ai/dsh-skill-filesystem",
};

function candidateRoots(explicitRoot) {
  const roots = [];
  const push = (value) => {
    if (value && !roots.includes(value)) roots.push(value);
  };
  push(explicitRoot);
  push(process.env.DSH_SHIPPED_ROOT);
  push(process.resourcesPath);
  const execDir = dirname(process.execPath || "");
  push(join(execDir, "resources"));
  push(execDir);
  return roots;
}

function candidateFiles(root, packageName) {
  const segments = packageName.split("/");
  return [
    join(root, "app.asar", "dsh", "node_modules", ...segments, ENTRY),
    join(root, "app.asar", "node_modules", ...segments, ENTRY),
    join(root, "dsh", "node_modules", ...segments, ENTRY),
    join(root, "node_modules", ...segments, ENTRY),
    join(root, "resources", "app.asar", "dsh", "node_modules", ...segments, ENTRY),
  ];
}

/** Absolute path of a shipped package entry, or null when it cannot be found. */
export function resolveShipped(packageName, explicitRoot) {
  for (const root of candidateRoots(explicitRoot)) {
    for (const file of candidateFiles(root, packageName)) {
      try {
        if (existsSync(file)) return file;
      } catch {
        // ignore unreadable candidates
      }
    }
  }
  return null;
}

const cache = new Map();

/** Import a shipped package by absolute asar path. */
export async function importShipped(packageName, explicitRoot) {
  const file = resolveShipped(packageName, explicitRoot);
  if (!file) {
    throw new Error(
      `dsh-market: cannot locate shipped package "${packageName}". ` +
        `Set shippedRoot in the market settings to the DeepSeek Harness "resources" directory.`,
    );
  }
  if (!cache.has(file)) {
    cache.set(
      file,
      import(pathToFileURL(file).href).catch((error) => {
        cache.delete(file);
        throw error;
      }),
    );
  }
  return cache.get(file);
}

/** Build a Cordis plugin descriptor from a package namespace export set. */
export function pluginFrom(namespace, name) {
  return {
    name,
    apply: namespace.apply,
    Config: namespace.Config,
    inject: namespace.inject,
    reusable: true,
  };
}
