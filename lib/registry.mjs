/**
 * Running viewers announce themselves here, one file per process, so that
 * `mdview comments wait` can find one to listen to. A viewer that dies
 * without cleaning up leaves its file behind. Readers drop such files once
 * they see the process is gone.
 */
import fs from "node:fs";
import path from "node:path";

function serversDir(home) {
  return path.join(home, "servers");
}

/** Announces this process as a viewer on `port`. Returns a function that withdraws the announcement. */
export function register(home, { port, root }) {
  const dir = serversDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, root, startedAt: new Date().toISOString() }));
  return () => fs.rmSync(file, { force: true });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** The viewers still running, newest first. */
export function liveServers(home) {
  const dir = serversDir(home);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const servers = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (alive(entry.pid)) servers.push(entry);
    else fs.rmSync(file, { force: true });
  }
  return servers.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
