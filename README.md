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

The header shows word count, reading time and when the file last changed. Its buttons copy the file's Markdown, open it in Cursor, and switch the theme. The dot turns green while live reload is connected. Clicking the file path copies its absolute path.

## Comments for agents

Select text in a doc and click **Comment** (or press ⌘⇧M) to leave a note for an agent. Threads float in the margin beside their text, and the agent answers from a terminal:

```bash
mdview comments list notes.md                          # unresolved threads: whose turn, where they sit
mdview comments list docs/ --waiting-on agent --full   # everything waiting on the agent under a folder, in full
mdview comments show 12 15                             # threads in full, with the source of their blocks
mdview comments reply 12 -m "Which section should this move to?"
mdview comments suggest-resolve 12 -m "Moved it under Rollout."
mdview comments wait docs/                             # returns the moment anything there waits on the agent
```

Agents reply and suggest that a thread is resolved. Only you resolve or reopen one, in the viewer, or with `--human` in a terminal. A suggested thread turns green, and replying to it reopens it. A thread the agent answered shows **Your turn** with a blue edge.

While you write a comment, live reload waits, so the text never moves under it (the dot turns amber), and the comment anchors to the version you selected in even if an agent edited the file meanwhile.

To keep an agent from reacting to each comment in turn, batch them. **Start batch** (or ⌥Enter) holds a comment as pending: you see it with a Pending chip, and agents see nothing. Once a batch is open, Enter adds to it and ⌘Enter sends it. **Send** in the header publishes everything at once, so the agent wakes once.

`wait` returns within milliseconds of a comment while a viewer is open, because each viewer streams a doorbell event the moment the store changes and `wait` listens to it. With no viewer, `wait` checks the store itself every 100 ms. An agent should answer every thread waiting on it before it waits again, since anything left unanswered returns at once.

Only you can delete, and only in the viewer: **Delete** on an open card removes the whole thread, and the × beside a reply removes that reply. Deleting is permanent. When a doc's last thread goes, mdview drops its stored versions too. [`skills/mdview-comments/SKILL.md`](skills/mdview-comments/SKILL.md) teaches an agent this loop. Copy it into your agent's skills folder.

mdview never writes your docs. Comments live in `~/.mdview/mdview.sqlite3` (set `MDVIEW_HOME` to move it), keyed by each file's real path. Once a doc has a comment, mdview keeps a copy of each version of it that it sees, and each comment remembers the version it was made on:

- A comment follows the doc into later versions while its paragraph, heading, list item, code block or table row keeps the same text. Reflowing a paragraph or renumbering a list does not change that.
- When the text changes, the comment is marked outdated and moves to the "On older versions" list. It shows what the text now reads and links to the version it was made on.

The version chip in the header (`v7`) lists every stored version. Renaming or moving a doc loses its comments. When a new mdview changes how the store is laid out, it copies the old store to `~/.mdview/backups/` before upgrading it.

## Safety

mdview listens on 127.0.0.1 only, refuses requests that name any other host (which blocks DNS rebinding), and serves only files under the root. Comment writes must come from mdview's own page: they need its Origin and a JSON body, which other websites cannot send. Docs render with their raw HTML, but the page's Content-Security-Policy runs only mdview's own scripts, so a doc cannot act as you, and files opened from the root are sandboxed. Raw HTML can still load images from anywhere, so point mdview at files you trust.

## Development

```bash
npm test               # everything; the browser tests drive headless Chrome and skip without it
npm run test:browser   # just the browser tests
```

The viewer is ES modules under `public/js/`, which the browser loads as they are. `public/js/lib/` holds the parts that never touch the page, so the unit tests in `test/ui/` import them directly. The stylesheet is split into files under `public/styles/`, in the order `index.css` imports them, and the server inlines them into `/static/style.css` on every request: there is no build step, and a CSS edit shows on reload. Browser tests look for Chrome at its macOS path, or at `MDVIEW_CHROME`.

Changes under `public/` show on a page reload. Changes under `lib/` need running viewers restarted.
