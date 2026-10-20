---
name: mdview-comments
description: Read and answer comments a human left on a Markdown doc in mdview, using the `mdview comments` CLI. Use when asked to address, answer, or work through comments or feedback on a doc, when the user mentions mdview comments, or says "check my comments on <doc>".
---

# mdview comments

The human reads Markdown docs in mdview and comments on selected text. The
comments live in a local SQLite store (`~/.mdview`), never in the doc. Read
and answer them with `mdview comments`, and edit the doc itself with your
usual file tools. If `mdview` is not on PATH, run
`node ~/code/mdview/bin/mdview.mjs comments ...` instead.

## The loop

1. `mdview comments list <doc-or-folder> --waiting-on agent --full` prints
   every thread waiting on you, in full: where it sits, the source of its
   block, and every message. A folder covers every doc with comments under
   it, so one call covers a whole spec folder. Pass several docs or folders
   at once rather than looping.
2. Edit the doc to address each thread, or decide not to and say why.
3. Answer each thread:
   - `mdview comments reply <id> -m "..."` to explain or to ask a question.
   - `mdview comments suggest-resolve <id> -m "<what changed>"` when it is
     done. The human confirms by resolving it.
4. Run `mdview comments list <doc-or-folder>` again and check each
   thread's state.

Without flags, `list` prints a summary of every unresolved thread.
`mdview comments show <id>...` prints chosen threads in full.

Never resolve or reopen a thread. Both belong to the human, and the CLI
refuses them without `--human`, a flag that is not for you.

## Where a thread sits

- `line 12`: the comment is on the text as it reads now.
- `from v3, block unchanged`: made on an earlier version, and its block
  still reads the same, so it applies as written.
- `outdated: made on v3, block changed since`: the text it was on has
  changed. `show` prints the old block and what it now reads. Check whether
  that change already addresses the comment before editing again.

## Also

- Set `MDVIEW_AUTHOR=<name>` so the human can tell agents apart.
- Every verb takes `--json` for structured output.
- `mdview comments add <doc> --line <n> -m "..."` asks the human about a
  block. `--quote <text>` picks the one block containing that text.
- `mdview comments wait <doc>` blocks until the human writes on the doc and
  prints one line per check. It exits 0 with the new comments, or 3 when it
  times out (`--timeout 30m` by default).
