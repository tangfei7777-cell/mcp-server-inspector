// @ts-check
/**
 * mcp-server-inspector - public API.
 *
 * One entry point, `inspect()`, that answers a single question: before I plug this
 * MCP server into an agent that holds my credentials, what do I actually know
 * about it?
 *
 * Two independent evidence sources feed the answer:
 *
 *   probe()   - run it and talk to it. Facts about behaviour.
 *   claimsFor()- read what it says about itself. Claims, not facts.
 *
 * The gap between those two is where most surprises live.
 */

import { probe as rawProbe, parseTarget } from "./probe.js";
import { claimsFor } from "./claims.js";
import { assess } from "./trust.js";
import { render, toJson, exitCodeFor } from "./report.js";
import { DESCRIPTION_RISKS, UNTESTED, WEIGHTS } from "./trust.js";

/**
 * Inspect an MCP server.
 *
 * @param {string} target  npm package name, local directory, or command line.
 * @param {object} [opts]
 * @param {boolean} [opts.probe]      Set false to skip the live probe (offline/metadata-only).
 * @param {number} [opts.timeoutMs]   Probe timeout, default 15000.
 * @param {typeof fetch} [opts.fetchImpl]  Injectable for tests.
 * @param {boolean} [opts.quiet]
 * @param {number} [opts.repeat]      How many times to probe. Timing from a single
 *   sample is unreliable - the same server measured 585ms to 1630ms across runs -
 *   so the timing verdict uses the minimum of several, and says how many it used.
 *   Default 1; 3 is a reasonable choice when the timing matters.
 * @returns {Promise<{target: string, probe: any, claims: any, trust: any, probed: boolean, exitCode: 0|1|2}>}
 */
async function inspect(target, opts) {
  const shouldProbe = opts?.probe !== false;
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const repeat = Math.max(1, Math.min(10, Math.floor(opts?.repeat ?? 1)));

  // Claims first: metadata is cheap and it can change how the probe is set up.
  // It also runs even when the probe is impossible, so a package that cannot be
  // started still gets a useful (if limited) report.
  const claims = await claimsFor(target, { fetchImpl: opts?.fetchImpl, timeoutMs: Math.min(timeoutMs, 10000) });

  /** @type {any} */
  let probeResult = null;
  let probed = false;
  if (shouldProbe) {
    if (!opts?.quiet) process.stderr.write(`正在探测 ${target}${repeat > 1 ? `（${repeat} 次采样）` : ""} …\n`);
    try {
      const spec = parseTarget(target);
      /** @type {any[]} */
      const runs = [];
      for (let i = 0; i < repeat; i++) {
        runs.push(await rawProbe(spec, { timeoutMs }));
        // A server that did not come up is not made healthier by trying again in a
        // way that hides the failure. Only repeat on success; the first failure is
        // the finding.
        if (runs[runs.length - 1].status !== "ok") break;
      }
      probeResult = reduceRuns(runs);
      probed = true;
    } catch (err) {
      probeResult = {
        status: "spawn-error",
        statusDetail: err instanceof Error ? err.message : String(err),
        tools: [],
        toolCount: 0,
        pages: 0,
        elapsedMs: 0,
        // Nothing ran, so there is no server-side cost to report. Zeros (rather than
        // copies of elapsedMs) keep trust.js from grading a launch failure on a
        // timing it never measured.
        serverMs: 0,
        launcherMs: 0,
        handshakeMs: 0,
        launchedAt: 0,
        usedLauncher: false,
        stderrLines: [],
        exitCode: null,
        exitedOnItsOwn: false,
        notes: [],
        instructions: "",
        protocolVersion: "",
      };
      probed = true;
    }
  }

  const trust = assess({ probe: probeResult, claims, probed });

  return {
    target,
    probe: probeResult,
    claims,
    trust,
    probed,
    exitCode: exitCodeFor(trust),
  };
}

/**
 * Collapse several probe runs of the same target into one result.
 *
 * The facts are taken from the last successful run (identity, tools, protocol - all
 * of which are stable), but the timing is the *minimum* across runs. Minimum rather
 * than mean because the noise is one-sided: a shared machine adds delay, it does not
 * remove it. The fastest observed run is therefore the closest estimate of what the
 * server actually costs, and averaging would fold our own scheduling jitter into the
 * server's number.
 *
 * `timingRuns` records how many samples the figure rests on, so the report can say
 * it rather than implying a precision that one sample cannot support.
 *
 * @param {any[]} runs
 * @returns {any}
 */
function reduceRuns(runs) {
  // A failure anywhere wins, regardless of position. inspect() stops sampling on the
  // first failure, so in practice the failing run is last - but this must not depend
  // on that, or a future caller reordering the loop would silently start reporting a
  // crashed server as healthy because an earlier run happened to succeed.
  const failed = runs.find((r) => r.status !== "ok");
  if (failed) return failed;

  const base = runs[runs.length - 1];
  const serverSamples = runs.map((r) => r.serverMs ?? r.elapsedMs).filter((n) => typeof n === "number" && n > 0);
  const elapsedSamples = runs.map((r) => r.elapsedMs);
  const launcherSamples = runs.map((r) => r.launcherMs ?? 0);

  return {
    ...base,
    serverMs: serverSamples.length > 0 ? Math.min(...serverSamples) : base.serverMs,
    elapsedMs: elapsedSamples.length > 0 ? Math.min(...elapsedSamples) : base.elapsedMs,
    launcherMs: launcherSamples.length > 0 ? Math.min(...launcherSamples) : base.launcherMs,
    timingRuns: runs.length,
    timingSamples: serverSamples,
  };
}

export {
  inspect,
  rawProbe as probe,
  parseTarget,
  claimsFor,
  assess,
  render,
  toJson,
  exitCodeFor,
  DESCRIPTION_RISKS,
  UNTESTED,
  WEIGHTS,
  reduceRuns,
};
