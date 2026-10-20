import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/mdview.mjs", import.meta.url));

let dir;
let env;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mdview-cli-"));
  env = { ...process.env, MDVIEW_HOME: path.join(dir, "home"), MDVIEW_USER: "adam", MDVIEW_AUTHOR: "spec-agent" };
  delete env.MDVIEW_SESSION;
});

function mdview(...args) {
  const res = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "comments", ...args], {
    cwd: dir,
    env,
    encoding: "utf8",
  });
  return { status: res.status, out: res.stdout, err: res.stderr };
}

async function writeDoc(name, content) {
  await fs.writeFile(path.join(dir, name), content);
  return name;
}

function startedId(res) {
  assert.equal(res.status, 0, res.err);
  return Number(/Started thread #(\d+)/.exec(res.out)[1]);
}

test("an agent answers a human's thread, and only the human resolves it", async () => {
  const doc = await writeDoc("flow.md", "# Plan\n\n## Storage\n\nStore versions in sqlite.\n");
  const id = startedId(mdview("add", doc, "--human", "--quote", "versions", "-m", "Global or per-root?"));

  const listed = mdview("list", doc);
  assert.match(listed.out, new RegExp(`#${id} open · waiting on agent · line 5 under "Storage"`));
  assert.match(listed.out, /> versions\n {2}adam \(.*, v1\): Global or per-root\?/);

  assert.equal(mdview("reply", String(id), "-m", "Global, keyed by realpath.").status, 0);
  assert.match(mdview("show", String(id)).out, /spec-agent · .* · v1\n {4}Global, keyed by realpath\./);

  const suggested = mdview("suggest-resolve", String(id), "-m", "Wrote it into the spec.");
  assert.match(suggested.out, new RegExp(`#${id} suggested resolved · waiting on human`));

  const refused = mdview("resolve", String(id));
  assert.equal(refused.status, 1);
  assert.match(refused.err, /Only a human may resolve/);

  assert.equal(mdview("resolve", String(id), "--human").status, 0);
  assert.match(mdview("list", doc).out, /Every thread is resolved/);
  assert.match(mdview("list", doc, "--all").out, new RegExp(`#${id} resolved`));
});

test("threads on later versions say whether their block survived", async () => {
  const doc = await writeDoc("versions.md", "Keep this.\n\nChange this.\n");
  const kept = startedId(mdview("add", doc, "--human", "--line", "1", "-m", "fine"));
  const changed = startedId(mdview("add", doc, "--human", "--line", "3", "-m", "reword"));
  await writeDoc("versions.md", "Keep this.\n\nChanged.\n");

  const { out } = mdview("list", doc);

  assert.match(out, /versions\.md · v2 · 2 open/);
  assert.match(out, new RegExp(`#${kept} open · waiting on agent · line 1 · from v1, block unchanged`));
  assert.match(out, new RegExp(`#${changed} open · waiting on agent · outdated: made on v1, block changed since \\(was line 3\\)`));
});

test("--json prints the thread views", async () => {
  const doc = await writeDoc("json.md", "One paragraph.\n");
  const id = startedId(mdview("add", doc, "--human", "--quote", "paragraph", "-m", "hi"));

  const listed = JSON.parse(mdview("list", doc, "--json").out);
  const replied = JSON.parse(mdview("reply", String(id), "-m", "hello", "--json").out);

  assert.equal(listed.version.seq, 1);
  assert.deepEqual(
    listed.threads.map((t) => [t.id, t.status, t.state, t.quote, t.waitingOn]),
    [[id, "open", "current", "paragraph", "agent"]],
  );
  assert.deepEqual(
    replied.thread.messages.map((m) => [m.author, m.authorKind, m.body]),
    [
      ["adam", "human", "hi"],
      ["spec-agent", "agent", "hello"],
    ],
  );
});

test("no verb writes the doc", async () => {
  const doc = await writeDoc("untouched.md", "# Title\n\nSome text.\n");
  const file = path.join(dir, doc);
  const before = { bytes: await fs.readFile(file), mtimeMs: (await fs.stat(file)).mtimeMs };

  const id = String(startedId(mdview("add", doc, "--human", "--line", "3", "-m", "x")));
  for (const args of [
    ["list", doc, "--all"],
    ["show", id],
    ["reply", id, "-m", "y"],
    ["suggest-resolve", id, "-m", "done"],
    ["reopen", id, "--human"],
    ["resolve", id, "--human", "-m", "thanks"],
  ]) {
    assert.equal(mdview(...args).status, 0, args.join(" "));
  }

  assert.deepEqual(await fs.readFile(file), before.bytes);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});

test("malformed commands exit 2 and refused ones exit 1", async () => {
  const doc = await writeDoc("errors.md", "Same.\n\nSame.\n");
  [
    { desc: "unknown verb", args: ["bogus", "x"], status: 2, err: /unknown verb "bogus"/ },
    { desc: "missing target", args: ["show"], status: 2, err: /missing <id>/ },
    { desc: "missing message", args: ["add", doc, "--line", "1"], status: 2, err: /needs a message/ },
    { desc: "bad line", args: ["add", doc, "--line", "zero", "-m", "x"], status: 2, err: /--line must be a line number/ },
    { desc: "missing file", args: ["list", "nope.md"], status: 2, err: /No such file: nope\.md/ },
    { desc: "ambiguous quote", args: ["add", doc, "--quote", "Same", "-m", "x"], status: 1, err: /appears in 2 blocks/ },
    { desc: "unknown thread", args: ["show", "999"], status: 1, err: /No thread #999/ },
  ].forEach((tc) => {
    const res = mdview(...tc.args);
    assert.equal(res.status, tc.status, tc.desc);
    assert.match(res.err, tc.err, tc.desc);
  });
  assert.match(mdview("list", doc).out, /No comments on errors\.md/);
});
