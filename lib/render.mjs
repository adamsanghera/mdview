import path from "node:path/posix";
import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import footnote from "markdown-it-footnote";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";
import GithubSlugger from "github-slugger";
import { extractBlocks } from "./blocks.mjs";
import { isMarkdown } from "./files.mjs";

const WORDS_PER_MINUTE = 230;
const TOC_MAX_LEVEL = 4;

// One slugger per render, so duplicate headings get GitHub's "-1", "-2" suffixes
// and in-doc links written against GitHub's anchors keep working.
const slugger = new GithubSlugger();

const md = new MarkdownIt({
  html: true,
  linkify: true,
  highlight(code, lang) {
    const language = lang && hljs.getLanguage(lang) ? lang : null;
    const body = language
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : md.utils.escapeHtml(code);
    const label = lang ? ` data-lang="${md.utils.escapeHtml(lang)}"` : "";
    return `<pre class="code"${label}><code class="hljs">${body}</code></pre>`;
  },
});

md.use(anchor, {
  level: [1, 2, 3, 4, 5, 6],
  slugify: (s) => slugger.slug(s),
  tabIndex: false,
});
md.use(footnote);
md.use(taskLists, { enabled: false, label: true });

md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
md.renderer.rules.table_close = () => "</table></div>\n";

const renderToken = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);
const defaultLinkOpen = md.renderer.rules.link_open ?? renderToken;
const defaultImage = md.renderer.rules.image;
const defaultFence = md.renderer.rules.fence;

// The default fence rule drops token attributes when highlight returns its own <pre>, as ours does.
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const html = defaultFence(tokens, idx, options, env, self);
  const block = tokens[idx].attrGet("data-block");
  return block === null ? html : html.replace("<pre", `<pre data-block="${block}"`);
};

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const target = resolveHref(token.attrGet("href"), env.dir);
  token.attrSet("href", target.href);
  if (target.kind === "external") {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  } else if (target.kind === "outside") {
    token.attrJoin("class", "outside-root");
    token.attrSet("title", "This file is outside the viewer's root. Restart mdview with --root to follow it.");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const target = resolveHref(token.attrGet("src"), env.dir);
  if (target.kind !== "external") token.attrSet("src", target.href);
  token.attrSet("loading", "lazy");
  return defaultImage(tokens, idx, options, env, self);
};

/**
 * Maps an href from a document in `dir` to a viewer URL.
 * - external: has a scheme (https:, mailto:, data:, cursor:) and is left alone
 * - anchor:   "#section" on the same page
 * - doc:      a Markdown file or folder under the root, opened in the viewer
 * - raw:      any other file under the root, served as-is
 * - outside:  climbs above the root, so the viewer cannot serve it
 */
export function resolveHref(href, dir = "") {
  if (!href) return { kind: "anchor", href: href ?? "" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return { kind: "external", href };
  if (href.startsWith("#")) return { kind: "anchor", href };

  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const pathPart = (hashAt >= 0 ? href.slice(0, hashAt) : href).split("?")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }
  const joined = decoded.startsWith("/") ? decoded.slice(1) : path.join(dir, decoded);
  const target = path.normalize(joined || ".");
  if (target === ".." || target.startsWith("../")) return { kind: "outside", href };

  const clean = target === "." ? "" : target.replace(/\/$/, "");
  const encoded = clean.split("/").map(encodeURIComponent).join("/");
  const looksLikeFolder = decoded.endsWith("/") || clean === "" || !path.extname(clean);
  if (isMarkdown(clean) || looksLikeFolder) return { kind: "doc", href: `/view/${encoded}${hash}` };
  return { kind: "raw", href: `/raw/${encoded}${hash}` };
}

/** Splits a leading YAML front matter block off the body, unparsed. */
export function splitFrontMatter(src) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!match) return { body: src, frontMatter: null };
  return { body: src.slice(match[0].length), frontMatter: match[1] };
}

function headingText(inline) {
  return (inline.children ?? [])
    .filter((t) => t.type === "text" || t.type === "code_inline")
    .map((t) => t.content)
    .join("")
    .trim();
}

function countWords(body) {
  const prose = body.replace(/```[\s\S]*?```/g, " ").replace(/<[^>]+>/g, " ");
  return (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? []).length;
}

function parse(src, env) {
  slugger.reset();
  const { body, frontMatter } = splitFrontMatter(src);
  const lineOffset = (src.slice(0, src.length - body.length).match(/\n/g) ?? []).length;
  const tokens = md.parse(body, env);
  return { body, frontMatter, tokens, blocks: extractBlocks(tokens, lineOffset) };
}

/** The commentable blocks of a document, indexed like the data-block tags in renderMarkdown's HTML. */
export function parseBlocks(src) {
  return parse(src, {}).blocks;
}

/**
 * Renders a Markdown document that lives at `relPath` under the root.
 * Returns the HTML plus what the page chrome needs: a title, a table of
 * contents, and length.
 */
export function renderMarkdown(src, relPath) {
  const dir = path.dirname(relPath) === "." ? "" : path.dirname(relPath);
  const env = { dir };
  const { body, frontMatter, tokens } = parse(src, env);

  const toc = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type !== "heading_open") continue;
    const level = Number(token.tag.slice(1));
    if (level > TOC_MAX_LEVEL) continue;
    toc.push({ level, id: token.attrGet("id"), text: headingText(tokens[i + 1]) });
  }

  const words = countWords(body);
  return {
    html: md.renderer.render(tokens, md.options, env),
    toc,
    title: toc.find((h) => h.level === 1)?.text || path.basename(relPath),
    words,
    minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    frontMatter,
  };
}
