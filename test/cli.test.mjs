import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "../lib/store.mjs";

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

/** Starts a CLI process without waiting for it. `done` resolves with its status and output. */
function mdviewInBackground(...args) {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", BIN, "comments", ...args], { cwd: dir, env });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  return {
    output: () => out,
    done: new Promise((resolve) => child.on("close", (status) => resolve({ status, out, err }))),
  };
}

async function until(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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

test("show says what an outdated block now reads", async () => {
  const doc = await writeDoc("now.md", "Retries never happen on a 4xx.\n");
  const id = startedId(mdview("add", doc, "--human", "--line", "1", "-m", "What about 429?"));
  await writeDoc("now.md", "Retries never happen on a 4xx, except a 429.\n");

  const { out } = mdview("show", String(id));

  assert.match(out, /Block in v1, line 1:\n {4}Retries never happen on a 4xx\.\n/);
  assert.match(out, /Now reads, in v2, line 1:\n {4}Retries never happen on a 4xx, except a 429\./);
});

test("wait returns when the human writes, and exits 3 at its timeout", async () => {
  const doc = await writeDoc("wait.md", "Waiting text.\n");
  const waiting = mdviewInBackground("wait", doc, "--interval", "1s", "--timeout", "20s");
  await until(() => waiting.output().includes("{next:1s}"));

  startedId(mdview("add", doc, "--human", "--line", "1", "-m", "Are you there?"));
  const woke = await waiting.done;
  const timedOut = mdview("wait", doc, "--interval", "1s", "--timeout", "1s");

  assert.equal(woke.status, 0, woke.err);
  assert.match(woke.out, /^no new comments on wait\.md \{next:1s\}$/m);
  assert.match(woke.out, /New comments on wait\.md:[\s\S]*adam \(.*\): Are you there\?/);
  assert.equal(timedOut.status, 3);
  assert.match(timedOut.out, /No new comments on wait\.md after 1s\./);
});

test("one list call covers a folder, keeps what waits on the agent, and prints it in full", async () => {
  await fs.mkdir(path.join(dir, "batch", "deep"), { recursive: true });
  const a = await writeDoc("batch/a.md", "Alpha paragraph.\n\nBeta paragraph.\n");
  const b = await writeDoc("batch/deep/b.md", "Gamma paragraph.\n");
  await writeDoc("batch/untouched.md", "No comments here.\n");
  const waiting = startedId(mdview("add", a, "--human", "--line", "1", "-m", "Tighten this."));
  const answered = startedId(mdview("add", a, "--human", "--line", "3", "-m", "Why beta?"));
  mdview("reply", String(answered), "-m", "Because of X.");
  const deep = startedId(mdview("add", b, "--human", "--line", "1", "-m", "Gamma needs a source."));

  const { status, out } = mdview("list", "batch", "--waiting-on", "agent", "--full");
  const json = JSON.parse(mdview("list", "batch", "--waiting-on", "agent", "--json").out);

  assert.equal(status, 0);
  assert.match(out, new RegExp(`#${waiting} open · waiting on agent`));
  assert.match(out, new RegExp(`#${deep} open · waiting on agent`));
  assert.match(out, /Block in v1, line 1:\n {4}Gamma paragraph\./);
  assert.doesNotMatch(out, new RegExp(`#${answered} `));
  assert.doesNotMatch(out, /untouched/);
  assert.deepEqual(
    json.map((d) => [path.basename(d.doc), d.threads.map((t) => t.id)]),
    [
      ["a.md", [waiting]],
      ["b.md", [deep]],
    ],
  );
});

test("show prints several threads in one call", async () => {
  const doc = await writeDoc("several.md", "One.\n\nTwo.\n");
  const first = startedId(mdview("add", doc, "--human", "--line", "1", "-m", "first"));
  const second = startedId(mdview("add", doc, "--human", "--line", "3", "-m", "second"));

  const { out } = mdview("show", String(first), String(second));
  const json = JSON.parse(mdview("show", String(first), String(second), "--json").out);

  assert.match(out, new RegExp(`^#${first} open[\\s\\S]*\\n---\\n\\n#${second} open`));
  assert.deepEqual(
    json.map((r) => r.thread.id),
    [first, second],
  );
});

test("--json prints the thread views", async () => {
  const doc = await writeDoc("json.md", "One paragraph.\n");
  const id = startedId(mdview("add", doc, "--human", "--quote", "paragraph", "-m", "hi"));

  const [listed] = JSON.parse(mdview("list", doc, "--json").out);
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

test("agents never see a human's pending comments", async () => {
  const doc = await writeDoc("drafts.md", "Visible.\n\nDrafted.\n");
  const visible = startedId(mdview("add", doc, "--human", "--line", "1", "-m", "sent"));
  const store = await openStore(env.MDVIEW_HOME);
  const file = path.join(dir, doc);
  const draft = store.createThread({ file, content: await fs.readFile(file, "utf8"), line: 3, body: "not sent", author: { name: "adam", kind: "human" }, pending: true });
  store.close();

  assert.match(mdview("list", doc).out, /1 open/);
  assert.doesNotMatch(mdview("list", doc, "--all").out, new RegExp(`#${draft} `));
  const onlyDrafts = await writeDoc("only-drafts.md", "Nothing sent yet.\n");
  const reopened = await openStore(env.MDVIEW_HOME);
  reopened.createThread({ file: path.join(dir, onlyDrafts), content: "Nothing sent yet.\n", line: 1, body: "draft", author: { name: "adam", kind: "human" }, pending: true });
  reopened.close();
  assert.equal(mdview("list", onlyDrafts).out, "No comments on only-drafts.md.\n");
  assert.match(mdview("show", String(draft)).err, new RegExp(`No thread #${draft}`));
  assert.match(mdview("show", String(visible)).out, new RegExp(`#${visible} open`));
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
    { desc: "deleting is for the human, in the viewer", args: ["delete", "1"], status: 2, err: /unknown verb "delete"/ },
    { desc: "single-thread verbs take one id", args: ["reply", "1", "2", "-m", "x"], status: 2, err: /takes one <id>, not 2/ },
    { desc: "bad --waiting-on", args: ["list", doc, "--waiting-on", "bob"], status: 2, err: /--waiting-on must be agent or human/ },
    { desc: "missing target", args: ["show"], status: 2, err: /missing <id>/ },
    { desc: "missing message", args: ["add", doc, "--line", "1"], status: 2, err: /needs a message/ },
    { desc: "bad line", args: ["add", doc, "--line", "zero", "-m", "x"], status: 2, err: /--line must be a line number/ },
    { desc: "missing file", args: ["list", "nope.md"], status: 2, err: /No such file or folder: nope\.md/ },
    { desc: "ambiguous quote", args: ["add", doc, "--quote", "Same", "-m", "x"], status: 1, err: /appears in 2 blocks/ },
    { desc: "unknown thread", args: ["show", "999"], status: 1, err: /No thread #999/ },
  ].forEach((tc) => {
    const res = mdview(...tc.args);
    assert.equal(res.status, tc.status, tc.desc);
    assert.match(res.err, tc.err, tc.desc);
  });
  assert.match(mdview("list", doc).out, /No comments on errors\.md/);
});
