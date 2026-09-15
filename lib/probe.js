// @ts-check
/**
 * Live probing: actually start the MCP server and talk to it.
 *
 * Why this cannot be replaced by reading a README: a README describes intent.
 * What matters before you install something into an agent that holds your tokens is
 * what the process does when you run it. Those two things disagree often enough
 * that measuring is the whole point.
 *
 * The probe performs the real stdio handshake:
 *
 *   1. spawn the server as a child process
 *   2. send `initialize` with a protocol version we support
 *   3. send `notifications/initialized`
 *   4. send `tools/list`, paginating until the server stops giving cursors
 *   5. terminate the child
 *
 * Everything about a server that is interesting at this layer is found in what
 * happens at step 2 or step 4. A server that never answers step 2 does not work. A
 * server that answers step 2 but exposes zero tools is a server whose advertised
 * capability does not exist. A server that answers with three tools when its README
 * promises twenty is telling you something.
 *
 * Failure handling is not an afterthought here. In practice, the majority of the
 * ways a probe goes wrong are not protocol errors - they are hangs, crashes, and
 * output that is not JSON at all. Each of those gets its own distinct outcome,
 * because "it hung" and "it exited immediately" point at completely different
 * problems and a single "failed" label would erase that difference.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Protocol revision this client speaks. A server may negotiate a different one. */
const CLIENT_PROTOCOL_VERSION = "2025-11-25";

/** Client identity sent in the initialize handshake. */
const CLIENT_INFO = { name: "mcp-server-inspector", version: "0.1.0" };

/**
 * Measured cost of npm's bootstrap, in ms, subtracted from an npm-launched target.
 *
 * This is a constant because it cannot be measured in-run: the launcher's work and
 * the server's work are interleaved inside one round trip (see the note in probe()),
 * so there is no in-band signal that tells them apart. What we have instead is a
 * controlled comparison on a single identical artifact:
 *
 *     via npx -y <pkg>       3445, 3399, 3502ms   avg 3449ms
 *     via node <same file>    777,  717,  741ms   avg  745ms
 *                                          difference       2704ms
 *
 * Rounded down to 2500ms so we under-correct rather than over-correct: erring high
 * would let a genuinely slow server hide behind a discount it did not need. The
 * value is a property of npm's CLI on a cold-ish filesystem, not of any server, so
 * it is applied uniformly and its exact size only shifts thresholds by well under
 * the noise these thresholds are set with.
 */
const LAUNCHER_COST_MS = 2500;

/**
 * Below this, no launcher discount is applied even when one was used. A launcher
 * that returned in under this long did not cost what the constant says - most
 * likely the server crashed immediately - and subtracting anyway would invent a
 * discount for a probe that barely ran.
 */
const LAUNCHER_FLOOR_MS = 3000;

/**
 * @typedef {object} ProbeTarget
 * @property {string} command   Executable to run.
 * @property {string[]} args    Arguments.
 * @property {Record<string,string>} [env]  Extra environment variables.
 * @property {string} [cwd]
 * @property {boolean} [viaLauncher]  Set by parseTarget when the target had to be
 *   wrapped in npm/npx. Surfaced on the probe result so the report can say why a
 *   slow wall-clock number is not the server's fault.
 */

/**
 * @typedef {object} ToolInfo
 * @property {string} name
 * @property {string} description
 * @property {object} inputSchema
 * @property {string[]} [annotations]   Annotation keys present, for risk reading.
 */

/**
 * @typedef {object} ProbeResult
 * @property {"ok"|"no-handshake"|"no-tools"|"crash"|"timeout"|"not-json"|"spawn-error"} status
 * @property {string} statusDetail
 * @property {string} [serverName]
 * @property {string} [serverVersion]
 * @property {string} instructions
 * @property {string} protocolVersion
 * @property {ToolInfo[]} tools
 * @property {number} toolCount
 * @property {number} pages            How many tools/list pages the server required.
 * @property {number} elapsedMs        Wall clock around the whole probe. Includes the
 *   launcher when one was interposed. Diagnostics; not graded.
 * @property {number} serverMs         The server's own cost, with a known launcher's
 *   share subtracted. This is the number trust.js grades and the report shows.
 * @property {number} launcherMs       How much was attributed to npm/npx. 0 when the
 *   target was launched directly.
 * @property {number} handshakeMs      Request-written to response. Kept for diagnostics:
 *   on an npm-launched target this still contains the launcher's bootstrap, because
 *   our write is buffered into it. Do not grade on it - see the note in probe().
 * @property {number} launchedAt       When the child was spawned (ms epoch).
 * @property {boolean} usedLauncher    True when we wrapped the target in npm/npx.
 * @property {string[]} stderrLines    Bounded capture, for diagnostics.
 * @property {number} exitCode
 * @property {boolean} exitedOnItsOwn  Server died without being asked to.
 */

/**
 * Probe a server over stdio.
 *
 * @param {ProbeTarget} target
 * @param {{timeoutMs?: number, maxStderrLines?: number, maxTools?: number}} [opts]
 * @returns {Promise<ProbeResult>}
 */
async function probe(target, opts) {
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const maxStderrLines = opts?.maxStderrLines ?? 40;
  const maxTools = opts?.maxTools ?? 2000;
  const started = Date.now();

  /** @type {string[]} */
  const stderrLines = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {{method: string, promise: Promise<any>, resolve: (v:any)=>void, reject:(e:Error)=>void, timer: NodeJS.Timeout}[]} */
  const pending = [];

  let child;
  try {
    child = spawn(target.command, target.args, {
      cwd: target.cwd,
      env: { ...process.env, ...(target.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (err) {
    return base({
      status: "spawn-error",
      statusDetail: err instanceof Error ? err.message : String(err),
    });
  }

  // Timing. There are two clocks here and it took a measurement to learn which one
  // is which.
  //
  // First attempt bounded the handshake by the moment we *write* `initialize`, on
  // the theory that the launcher's cost finished before that. The measurement
  // falsified it. Timeline for `npx -y @modelcontextprotocol/server-sequential-thinking`:
  //
  //     21ms  spawn returned
  //    139ms  initialize written
  //   5963ms  response arrived
  //
  // and for server-filesystem the server's own startup banner appeared at 4864ms
  // with the response at 4881ms. So npm's bootstrap is not a prelude that finishes
  // before we write - the write is buffered into it, and the whole launcher cost
  // lands inside the round trip. Writing-timestamped timing therefore measures npm
  // exactly as much as the wall clock does; it fixes nothing.
  //
  // The honest separation is by launch path, measured on one identical artifact:
  //
  //     via npx -y <pkg>       3445, 3399, 3502ms   avg 3449ms
  //     via node <same file>    777,  717,  741ms   avg  745ms
  //
  // A 2704ms difference that is npm, not the server, and that is paid on every
  // launch (warm runs are no faster, so it is bootstrap, not download).
  //
  // So: elapsedMs is wall clock, and serverMs subtracts the launcher's share when we
  // know we interposed one. Both are reported; only serverMs is graded.
  let handshakeMs = 0;
  let requestWrittenAt = 0;
  // Whether we had to interpose a package runner. When we did, the wall clock
  // measures npm's startup plus the server's, and only handshakeMs is about the
  // server. The report needs to know which case it is looking at.
  const usedLauncher = target.viaLauncher === true;
  /** @type {ProbeResult["status"]} */
  let status = "ok";
  let statusDetail = "";
  let exitedOnItsOwn = false;
  let exitCode = /** @type {number|null} */ (null);
  // A spawn failure is terminal: the child never existed, so no later
  // observation about it can be more informative than this one. Latching it
  // matters because Node still reports an errno on `child.exitCode` when a
  // binary is missing (observed: -4058 on Windows, ENOENT), which otherwise
  // reads as "the server crashed" and buries the real diagnosis.
  let spawnFailed = false;

  // A server that dies before we finish is a distinct outcome from one that hangs.
  // Recording which happened is what lets the report say "it crashed" instead of
  // the useless "it failed".
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => {
      exitCode = code;
      if (pending.length > 0) {
        exitedOnItsOwn = true;
        for (const p of pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`server exited with code ${code} while awaiting ${p.method}`));
        }
        pending.length = 0;
      }
      resolve(undefined);
    });
  });
  child.once("error", (err) => {
    spawnFailed = true;
    status = "spawn-error";
    statusDetail = err.message;
    // Reject anything waiting: the "timeout awaiting initialize" message would be
    // technically true but actively misleading, since nothing was ever listening.
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`spawn failed: ${err.message}`));
    }
    pending.length = 0;
  });

  let buffer = "";
  child.stdout?.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    // Frames are newline-delimited JSON. A partial frame stays in the buffer.
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // Not JSON on stdout. MCP servers sometimes print banners or logs there,
        // which is itself a finding: a client reading stdout as protocol will
        // choke on it. Record it once rather than spamming.
        if (notes.length < 5) notes.push(`stdout carried non-JSON: ${line.slice(0, 120)}`);
        continue;
      }
      const waiter = pending.find((p) => p && msg.id !== undefined && msg.id === p.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.splice(pending.indexOf(waiter), 1);
        waiter.resolve(msg);
      }
    }
  });

  // Writing to the stdin of a process that has already died raises an `error`
  // event on the stream. Left unhandled, that event is fatal to *this* process:
  // a probe of a crashing server would take down the probe itself, which is the
  // worst possible failure for a diagnostic tool. Swallow it here; the exit
  // handler is what produces the real diagnosis.
  child.stdin?.on("error", () => {});

  child.stderr?.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      if (stderrLines.length < maxStderrLines) stderrLines.push(line.slice(0, 300));
    }
  });

  /**
   * Send a request and await its response, bounded by the overall timeout.
   * @param {string} method
   * @param {any} params
   * @returns {Promise<any>}
   */
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = requestSeq++;
      const entry = /** @type {any} */ ({
        id,
        method,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = pending.indexOf(entry);
          if (idx >= 0) pending.splice(idx, 1);
          reject(new Error(`timeout awaiting ${method}`));
        }, timeoutMs),
      });
      pending.push(entry);
      try {
        // Stamp the write, not the spawn. See the timing note above: this is where
        // the server's own latency begins, and only the initialize call sets it -
        // later calls would overwrite the handshake measurement with a tools/list
        // round trip.
        if (method === "initialize") requestWrittenAt = Date.now();
        child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (err) {
        clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** @param {string} method @param {any} params */
  function notify(method, params) {
    try {
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      // A closed stdin means the server is already gone; the exit handler will
      // produce the real diagnosis.
    }
  }

  let requestSeq = 1;

  /** @type {ProbeResult} */
  let result;

  try {
    // Step 2: initialize. This is the single most informative call in the protocol.
    // A server that cannot complete it is not usable, whatever its README says.
    const init = await request("initialize", {
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      capabilities: { tools: {}, roots: { listChanged: false } },
      clientInfo: CLIENT_INFO,
    });
    // Close the handshake clock here, before any further work. Everything between
    // the initialize write and its response is the server: the launcher's startup
    // happened strictly before requestWrittenAt, so it cannot leak into this.
    if (requestWrittenAt > 0) handshakeMs = Date.now() - requestWrittenAt;

    const initResult = init?.result;
    if (!initResult || typeof initResult !== "object") {
      // Note: this must not `return` early. The success path assigns status onto
      // the result object after this block, and an early return would skip that,
      // handing back a default-status object that reads as "ok" - which is the
      // exact failure this line exists to detect. Record the diagnosis and let
      // control reach the single assignment point.
      status = "no-handshake";
      statusDetail = init?.error
        ? `initialize returned an error: ${JSON.stringify(init.error).slice(0, 200)}`
        : "initialize returned no result object";
      result = base({});
    } else {
      notify("notifications/initialized", {});

      const serverInfo = initResult.serverInfo ?? {};

      // Step 4: tools/list, paginating. Servers that paginate under-report their
      // tools if you only read the first page, and under-reporting is exactly the
      // error this tool exists to catch - so it must not commit it itself.
      /** @type {ToolInfo[]} */
      const tools = [];
      let pages = 0;
      let cursor = undefined;
      let listError = "";

      while (pages < 50 && tools.length < maxTools) {
        const res = await request("tools/list", cursor ? { cursor } : {});
        if (res?.error) {
          listError = JSON.stringify(res.error).slice(0, 200);
          break;
        }
        const list = res?.result?.tools;
        if (!Array.isArray(list)) {
          if (pages === 0) {
            status = "no-tools";
            statusDetail = "tools/list returned no tools array";
          }
          break;
        }
        pages++;
        for (const t of list) {
          if (!t || typeof t.name !== "string") continue;
          tools.push({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: t.inputSchema ?? {},
            annotations: t.annotations && typeof t.annotations === "object" ? Object.keys(t.annotations) : [],
          });
        }
        cursor = res?.result?.nextCursor;
        if (!cursor) break;
      }

      if (status === "ok" && tools.length === 0) {
        // Distinct from "failed to list": the server answered cleanly and offered
        // nothing. The distinction matters because it separates "broken" from
        // "advertised capabilities do not exist".
        status = "no-tools";
        statusDetail = listError ? `tools/list errored: ${listError}` : "server exposes zero tools";
      }

      result = base({
        serverName: typeof serverInfo.name === "string" ? serverInfo.name : undefined,
        serverVersion: typeof serverInfo.version === "string" ? serverInfo.version : undefined,
        instructions: typeof initResult.instructions === "string" ? initResult.instructions : "",
        protocolVersion: typeof initResult.protocolVersion === "string" ? initResult.protocolVersion : "",
        tools,
        pages,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (spawnFailed) {
      // Already diagnosed at the source; do not let a downstream timeout or exit
      // observation relabel it as a crash.
      status = "spawn-error";
    } else if (/spawn failed/.test(msg)) {
      status = "spawn-error";
      statusDetail = msg;
    } else if (/timeout awaiting/.test(msg)) {
      status = child.exitCode !== null || exitedOnItsOwn ? "crash" : "timeout";
      statusDetail =
        status === "crash"
          ? `server exited before responding (exit code ${exitCode})`
          : `server did not respond within ${timeoutMs}ms`;
    } else if (/exited with code/.test(msg)) {
      status = "crash";
      statusDetail = msg;
    } else {
      status = "not-json";
      statusDetail = msg;
    }
    result = base({});
  } finally {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    // Do not await the exit event: a server that ignores SIGTERM would hold the
    // probe open forever. Give it a moment, then let the process be reaped.
    await Promise.race([exited, sleep(500)]);
  }

  result.status = status;
  result.statusDetail = statusDetail;
  result.elapsedMs = Date.now() - started;
  // Subtract the launcher's share only when we actually interposed one, and only
  // when there is something to subtract. A directly-launched server pays no
  // launcher cost and must not be credited for a discount it never received.
  const launcherShare = usedLauncher && handshakeMs > LAUNCHER_FLOOR_MS ? LAUNCHER_COST_MS : 0;
  result.launcherMs = launcherShare;
  result.serverMs = Math.max(0, result.elapsedMs - launcherShare);
  result.handshakeMs = handshakeMs;
  result.launchedAt = started;
  result.usedLauncher = usedLauncher;
  result.stderrLines = stderrLines;
  // A child that never spawned has no exit code. Node leaves the errno in
  // `child.exitCode` (negative), which would read as a real exit status.
  result.exitCode = spawnFailed ? null : exitCode;
  result.exitedOnItsOwn = exitedOnItsOwn;
  result.notes = notes;
  result.toolCount = result.tools.length;
  return result;

  /**
   * @param {Partial<ProbeResult>} over
   * @returns {ProbeResult}
   */
  function base(over) {
    return {
      status: "ok",
      statusDetail: "",
      serverName: undefined,
      serverVersion: undefined,
      instructions: "",
      protocolVersion: "",
      tools: [],
      toolCount: 0,
      pages: 0,
      elapsedMs: 0,
      serverMs: 0,
      launcherMs: 0,
      handshakeMs: 0,
      launchedAt: 0,
      usedLauncher: false,
      stderrLines,
      exitCode: null,
      exitedOnItsOwn: false,
      notes,
      ...over,
    };
  }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Turn a user-supplied target string into something spawnable.
 *
 * Accepts:
 *   "npx -y some-server"        - a shell-ish command line, split on whitespace
 *   "./server.js --flag"        - a local script
 *   "@scope/name"               - a bare package name, run through npx
 *
 * No shell is used, so quoting is handled here. The split is intentionally naive:
 * it handles spaces and simple quotes, which covers every real MCP invocation
 * shape. Anything needing a full shell grammar should be wrapped by the caller.
 *
 * @param {string} spec
 * @returns {ProbeTarget}
 */
function parseTarget(spec) {
  const tokens = tokenize(String(spec ?? "").trim());
  if (tokens.length === 0) throw new Error("empty target");
  const first = tokens[0];
  if (/^\.{0,2}[\\/]/.test(first) || /\.(?:js|mjs|cjs|ts)$/.test(first)) {
    // A path: run it with node so that platform shebang handling is irrelevant.
    //
    // Check it exists first. Without this, a typo'd path is handed to node, the
    // spawn succeeds, and the server dies with MODULE_NOT_FOUND - which surfaces
    // as a "crash" finding about the *server*. That is a wrong diagnosis: there
    // is no server, the user mistyped a path. Catching it here keeps the
    // distinction between our input being wrong and their code being broken.
    const resolved = path.resolve(first);
    if (!existsSync(resolved)) {
      throw new Error(`路径不存在: ${resolved}`);
    }
    return { command: process.execPath, args: tokens };
  }
  // An explicit invocation is left exactly as written. Rewriting it would be
  // both surprising and wrong: "npx -y pkg" is already complete, and prepending
  // another "-y npx" produces "npx -y npx -y pkg".
  const RUNNERS = new Set(["npx", "bunx", "pnpx", "yarn", "pnpm", "npm", "node", "uvx", "deno", "python", "python3"]);
  if (RUNNERS.has(first)) {
    if (first === "npx" || first === "npm") {
      const viaNode = nodeRunnableNpmCli(first);
      if (viaNode) return { command: process.execPath, args: [viaNode, ...tokens.slice(1)], viaLauncher: true };
      return { command: first, args: tokens.slice(1), viaLauncher: true };
    }
    return { command: first, args: tokens.slice(1) };
  }
  if (/^@?[\w.-]+(?:\/[\w.-]+)?$/.test(first)) {
    // A bare package name and nothing else: assume it is meant to be run via npx.
    // Resolve it to the npm CLI script when possible - see nodeRunnableNpmCli for
    // why a bare "npx" cannot be spawned on Windows.
    const viaNode = nodeRunnableNpmCli("npx");
    if (viaNode) return { command: process.execPath, args: [viaNode, "-y", ...tokens], viaLauncher: true };
    return { command: "npx", args: ["-y", ...tokens], viaLauncher: true };
  }
  return { command: first, args: tokens.slice(1) };
}

/**
 * Locate npm's CLI entry point so `npx`/`npm` can be run as a plain Node script.
 *
 * Why this exists: on Windows, `spawn("npx")` fails with ENOENT (the executable
 * on PATH is `npx.cmd`, and there is no extensionless file), and
 * `spawn("npx.cmd")` fails with EINVAL (Windows refuses to exec a .cmd without a
 * shell, a hardening measure). The only remaining option is `shell: true`, which
 * we do not want: it re-introduces shell quoting and injection risk around
 * user-supplied package names.
 *
 * Running the CLI's JavaScript directly under our own node binary sidesteps the
 * whole problem, and behaves identically on Linux and macOS.
 *
 * @param {"npx"|"npm"} which
 * @returns {string} Absolute path to the CLI script, or "" if it cannot be found.
 */
function nodeRunnableNpmCli(which) {
  const script = which === "npm" ? "npm-cli.js" : "npx-cli.js";

  // 1. Node's own layout: <nodeDir>/node_modules/npm/bin/<script>
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", script),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", script),
  ];

  // 2. Whatever npm/npx is on PATH. Following the shim is only needed to find the
  //    install root; if it is a shell shim, derive the sibling layout directly.
  const onPath = whichOnPath(which);
  if (onPath) {
    const dir = path.dirname(onPath);
    candidates.push(
      path.join(dir, "node_modules", "npm", "bin", script),
      path.join(dir, "..", "lib", "node_modules", "npm", "bin", script),
      path.join(dir, "..", "node_modules", "npm", "bin", script),
    );
  }

  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return "";
}

/**
 * Minimal `which`/`where` that does not shell out, so it stays usable in the same
 * environments where spawning is the problem we are working around.
 * @param {string} cmd
 * @returns {string} Path of the first match, or "".
 */
function whichOnPath(cmd) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      if (existsSync(p)) return p;
    }
  }
  return "";
}

/**
 * Split a command line on whitespace, honouring single and double quotes.
 * @param {string} s
 * @returns {string[]}
 */
function tokenize(s) {
  /** @type {string[]} */
  const out = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = "";
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export { probe, parseTarget, tokenize, nodeRunnableNpmCli, whichOnPath, CLIENT_PROTOCOL_VERSION, CLIENT_INFO };
