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

## Comments for agents

Select text in a doc and click **Comment** (or press ⌘⇧M) to leave a note for an agent. Threads float in the margin beside their text, and the agent answers from a terminal:

```bash
mdview comments list notes.md          # unresolved threads: whose turn, where they sit
mdview comments show 12                # one thread, with the source of its block
mdview comments reply 12 -m "Which section should this move to?"
mdview comments suggest-resolve 12 -m "Moved it under Rollout."
mdview comments wait notes.md          # blocks until you write something new
```

Agents reply and suggest that a thread is resolved. Only you resolve or reopen one, in the viewer, or with `--human` in a terminal. A suggested thread turns green, and replying to it reopens it. [`skills/mdview-comments/SKILL.md`](skills/mdview-comments/SKILL.md) teaches an agent this loop. Copy it into your agent's skills folder.

mdview never writes your docs. Comments live in `~/.mdview/mdview.sqlite3` (set `MDVIEW_HOME` to move it), keyed by each file's real path. Once a doc has a comment, mdview keeps a copy of each version of it that it sees, and each comment remembers the version it was made on:

- A comment follows the doc into later versions while its paragraph, heading, list item, code block or table row keeps the same text. Reflowing a paragraph or renumbering a list does not change that.
- When the text changes, the comment is marked outdated and moves to the "On older versions" list. It shows what the text now reads and links to the version it was made on.

The version chip in the header (`v7`) lists every stored version. Renaming or moving a doc loses its comments.

## Safety

mdview listens on 127.0.0.1 only, refuses requests that name any other host (which blocks DNS rebinding), and serves only files under the root. Comment writes must come from mdview's own page: they need its Origin and a JSON body, which other websites cannot send. Markdown may contain raw HTML, so point it at files you trust.

## Tests

```bash
npm test
```
