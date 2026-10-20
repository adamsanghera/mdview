#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { startServer } from "../lib/server.mjs";
import { toPosix } from "../lib/files.mjs";

const USAGE = `Usage: mdview [file-or-folder] [options]
       mdview comments <verb> [options]

Opens a Markdown file or folder in a local reader. "mdview comments --help"
lists the verbs agents use to read and answer comments.

Options:
  -r, --root <dir>   Serve this folder (default: the folder you opened, or the file's folder).
                     Widen it to follow relative links into sibling folders.
  -p, --port <n>     First port to try (default: 4545; moves up if taken).
      --no-open      Print the URL without opening a browser.
  -h, --help         Show this help.`;

function fail(message) {
  console.error(`mdview: ${message}`);
  process.exit(1);
}

async function view(argv) {
  let args;
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: "string", short: "r" },
        port: { type: "string", short: "p" },
        "no-open": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`);
  }

  const { values, positionals } = args;
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const target = path.resolve(positionals[0] ?? ".");
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) fail(`no such file or folder: ${target}`);

  const root = path.resolve(values.root ?? (stat.isDirectory() ? target : path.dirname(target)));
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) fail(`--root is not a folder: ${root}`);

  const initial = toPosix(path.relative(root, target));
  if (initial === ".." || initial.startsWith("../") || path.isAbsolute(initial)) {
    fail(`${target} is outside --root ${root}`);
  }

  const port = values.port ? Number(values.port) : 4545;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid port: ${values.port}`);

  const { url } = await startServer({ root, initial, port });
  console.log(`mdview serving ${root}`);
  console.log(`  ${url}`);

  if (!values["no-open"]) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  }
}

const argv = process.argv.slice(2);
if (argv[0] === "comments") {
  const { runComments } = await import("../lib/comments-cli.mjs");
  process.exitCode = await runComments(argv.slice(1));
} else {
  await view(argv);
}
