# mdview

A local Markdown reader. Point it at a file or a folder, and it opens a browser tab with:

- GitHub-flavored rendering: tables, task lists, footnotes and syntax-highlighted code
- a file sidebar you can filter, and an "On this page" outline that follows your scroll
- relative links between documents that open in the viewer, with images served alongside
- live reload: save the file and the page updates without losing your place
- light and dark themes that follow the system, or pick one

## Setup

```bash
cd ~/code/mdview
npm install
npm link   # optional: puts `mdview` on your PATH
```

Without `npm link`, run `node ~/code/mdview/bin/mdview.mjs` in place of `mdview`.

## Use

```bash
mdview notes.md                    # opens notes.md; the sidebar lists its folder
mdview docs/                       # opens docs/README.md, index.md, or the first file
mdview --root docs docs/a/b.md     # serves all of docs/, starting at a/b.md
mdview --port 5000 --no-open       # first port to try, and no browser tab
```

The sidebar and links reach only files under the root. A link that climbs above it shows dotted, and clicking it says to restart with a wider `--root`.

| Key | Does |
|---|---|
| `/` | filter files (Enter opens the first match, Esc clears) |
| `\` | show or hide the file list |

The header shows word count, reading time and when the file last changed. Its buttons copy the file's Markdown, open it in Cursor, and switch the theme. The dot turns green while live reload is connected.

## Safety

mdview listens on 127.0.0.1 only, refuses requests that name any other host (which blocks DNS rebinding), and serves only files under the root. Markdown may contain raw HTML, so point it at files you trust.

## Tests

```bash
npm test
```
