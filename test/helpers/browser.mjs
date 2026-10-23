/**
 * Drives headless Chrome over the DevTools protocol, with Node's built-in
 * WebSocket, so the viewer's tests need no browser-automation dependency.
 * Tests skip when Chrome is missing; MDVIEW_CHROME overrides its path.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const CHROME = process.env.MDVIEW_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WAIT_MS = 5000;
const POLL_MS = 20;

export const chromeMissing = fs.existsSync(CHROME) ? false : `Chrome not found at ${CHROME} (set MDVIEW_CHROME)`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns something truthy, and returns that. Throws after `timeout` ms. */
export async function until(check, { timeout = WAIT_MS, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

/**
 * For a test file's top level: returns a function that launches one Chrome on
 * first use and shares it, closed after the file's tests. A file whose tests
 * are all filtered out never launches one, and so never waits on it.
 */
export function sharedChrome() {
  let launching;
  after(async () => {
    if (launching) await (await launching).close();
  });
  return () => (launching ??= launchChrome());
}

/** Starts a headless Chrome with a throwaway profile. */
export async function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mdview-chrome-"));
  // Its own process group, so close() can stop Chrome's helper processes along with it.
  const proc = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
    { stdio: "ignore", detached: true },
  );
  // Chrome writes the port it picked to DevToolsActivePort in the profile.
  const readPort = () => {
    try {
      return fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0];
    } catch {
      return null;
    }
  };
  const port = await until(readPort, { what: "Chrome to start" }).catch((err) => {
    process.kill(-proc.pid, "SIGTERM");
    throw err;
  });
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    /** Opens a tab at `url` with a viewport of `width` × `height`, and waits for it to load. */
    async open(url, { width = 1800, height = 1100 } = {}) {
      const target = await fetch(`${endpoint}/json/new?about:blank`, { method: "PUT" }).then((res) => res.json());
      const page = await connect(target.webSocketDebuggerUrl, () => fetch(`${endpoint}/json/close/${target.id}`));
      await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await page.goto(url);
      return page;
    },
    async close() {
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      process.kill(-proc.pid, "SIGTERM");
      await exited;
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch {
        // A leftover temp profile is harmless, and not what any test is about.
      }
    },
  };
}

async function connect(wsUrl, closeTarget) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const calls = new Map();
  const listeners = new Map();
  const errors = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined) {
      const call = calls.get(msg.id);
      calls.delete(msg.id);
      if (msg.error) call?.reject(new Error(`${call.method}: ${msg.error.message}`));
      else call?.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const details = msg.params.exceptionDetails;
      errors.push(details.exception?.description ?? details.text);
    }
    for (const listener of listeners.get(msg.method) ?? []) listener(msg.params);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      calls.set(id, { method, resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const once = (method) =>
    new Promise((resolve) => {
      const set = listeners.get(method) ?? new Set();
      const listener = (params) => {
        set.delete(listener);
        resolve(params);
      };
      set.add(listener);
      listeners.set(method, set);
    });

  await send("Runtime.enable");
  await send("Page.enable");

  const page = {
    send,
    /** Uncaught exceptions the page has thrown so far. */
    errors,
    /**
     * Runs `fn` in the page with JSON-serializable `args` and returns its
     * JSON-serializable result, awaiting it if it is a promise.
     */
    async eval(fn, ...args) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression: `(${fn})(...${JSON.stringify(args)})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    },
    /** Polls `fn` in the page until it returns something truthy, and returns that. */
    waitFor(fn, { timeout, what = String(fn) } = {}, ...args) {
      return until(() => page.eval(fn, ...args), { timeout, what });
    },
    async goto(url) {
      const loaded = once("Page.loadEventFired");
      await send("Page.navigate", { url });
      await loaded;
    },
    async resize(width, height) {
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    },
    async screenshot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(data, "base64"));
    },
    async close() {
      ws.close();
      await closeTarget();
    },
  };
  return page;
}
