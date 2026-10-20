import fs from "node:fs/promises";
import path from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__"]);
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const MAX_DEPTH = 8;
const MAX_FILES = 3000;
const INDEX_NAMES = ["README.md", "readme.md", "index.md", "00-overview.md"];

export function isMarkdown(name) {
  return MARKDOWN.test(name);
}

/** Root-relative paths use "/" on every platform, so URLs and the sidebar agree. */
export function toPosix(rel) {
  return rel.split(path.sep).join("/");
}

/**
 * Resolves a root-relative path to an absolute one, or returns null when the
 * result would leave the root. Absolute inputs and ".." segments that climb
 * past the root are refused.
 */
export function resolveInRoot(root, rel) {
  if (typeof rel !== "string" || rel.includes("\0")) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * Lists Markdown files under root as sorted root-relative paths. Hidden
 * entries and dependency or build folders are skipped. Numeric-aware sorting
 * keeps "2-foo" before "10-foo".
 */
export async function listMarkdown(root) {
  const files = [];
  async function walk(dir, relDir, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.stat(abs);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        } catch {
          continue;
        }
      }
      if (isDir && !SKIP_DIRS.has(entry.name)) await walk(abs, rel, depth + 1);
      else if (isFile && isMarkdown(entry.name)) files.push(rel);
    }
  }
  await walk(root, "", 0);
  return files;
}

/**
 * Picks the Markdown file to show for a directory: a conventional index name
 * if one exists, otherwise the first Markdown file in it.
 */
export async function pickIndex(absDir) {
  const entries = await fs.readdir(absDir).catch(() => []);
  for (const name of INDEX_NAMES) {
    if (entries.includes(name)) return name;
  }
  return entries.filter(isMarkdown).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0] ?? null;
}
