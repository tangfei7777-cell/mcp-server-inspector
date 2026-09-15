# mcp-server-inspector

English | [中文](README.zh-CN.md)

**Before you wire an MCP server into your agent, make sure you actually know what you know about it.**

The MCP ecosystem now has well over a hundred thousand servers (see "Ecosystem data and sources" below), and the usual basis for picking one is a README. A README describes **intent**. When you plug a server into an agent that holds your credentials, what really matters is what it **does when it runs**. Those two diverge often enough that the only sound approach is to measure it.

`mcp-server-inspector` does one thing: **connect to it for real, then report honestly.**

```bash
npx mcp-server-inspector @modelcontextprotocol/server-filesystem
```

---

## It's a health report, not a registry

This needs to be said up front, because the two get conflated easily.

| | Does | Does not |
|---|---|---|
| **Registry** | Index, search, and distribute server packages | Tell you what a given package does when it runs |
| **mcp-server-inspector** | Launch it, shake hands, see what it actually exposes, and compare that against what it claims | Index, search, or decide for you which one to install |

A registry answers "what's out there"; `mcp-server-inspector` answers "what is the situation with this one." The two are complementary, not competitive.

It is also not a security audit. The reasoning is spelled out in "What we don't test" below — that section is the most important one in this document.

---

## It does three things

### 1. Connect for real (not guess from docs)

Speaks the full stdio handshake:

```
spawn child process
  → initialize                                        (protocol version 2025-11-25)
  → notifications/initialized
  → tools/list                                        (follow nextCursor until the last page)
  → terminate child process
```

Following the pagination matters in its own right: reading only the first page **under-reports** the tool count, and "under-reporting" is precisely why this tool exists, so it must never make that mistake itself.

### 2. Read its static declarations

Reads `package.json` and the `README`: dependency count, **install-time scripts**, license, repo URL, release date, number of maintainers.

Install-time scripts are **reported only, never executed.** There are no exceptions to this.

And the two kinds of scripts must be told apart, because their threat models are completely different:

| Category | Scripts | Runs on whose machine | Weight |
|---|---|---|---|
| **Consumer side** | `preinstall` / `install` / `postinstall` | the **user's** machine, auto-run on `npm install` | −20 (risk) |
| **Maintainer side** | `prepare` / `prepublishOnly` | the maintainer's own build/release flow | −1 (info, disclosure only) |

Confusing the two at the start meant **nearly every TypeScript package** was graded high-risk. Measured on the official `@modelcontextprotocol/server-everything`, this one confusion alone ate 20 points, dragging the MCP project's own reference implementation from `usable` to `caution` (50/100, exit 1). `prepare` is a standard build step for TypeScript projects; it does not run during the consumer's install, so it is not a consumer-side execution surface. Once separated, the same server returns to 74/100, exit 0.

### 3. Write the gap up as a report

The report always has three sections:

```
1. Facts       reproducible observations, same for whoever runs it
2. Judgment    conclusions drawn from the facts above; you may disagree
3. Untested    printed unconditionally
```

The third section is **always printed**, even at a perfect score.

---

## Why failure modes must be distinguishable

This is the most important engineering decision in the tool.

How does probing a server fail? In practice most failures are **not protocol errors** — they hang, crash, or emit something that isn't JSON. A single "failed" label would erase the most useful information, because "it hung" and "it exited immediately" point to completely different fixes.

So probe results have 7 states, each an independent label:

| State | Meaning | Usually means |
|---|---|---|
| `ok` | handshake completed | usable |
| `no-handshake` | started, but `initialize` got no valid response | broken protocol implementation; clients can't connect |
| `no-tools` | handshake OK, but 0 tools | claimed capability doesn't exist |
| `crash` | exited on its own before the response completed | missing env var, missing dep, dies at startup |
| `timeout` | neither exited nor answered | deadlock, waiting for input, blocked |
| `not-json` | stdout isn't a valid protocol frame | logging/banner dumped into the protocol channel |
| `spawn-error` | the process never came up at all | binary missing, bad path, wrong permissions |

**`crash` and `spawn-error` must be separated**, and there's a real trap here: on Windows, when the binary is missing, Node still stuffs an error code into `child.exitCode` (measured `-4058`, i.e. `ENOENT`). If you read that value at face value, a "wrong command typed" gets reported as "server crashed" — a completely different fix. So the tool **latches** the startup failure: no downstream observation can overwrite it, and it zeroes `exitCode` to `null` (a process that never existed has no exit code).

---

## Time the server, not npm

This section records a hypothesis that **measurement disproved**, because the process of disproving it shows why "measure before you change" matters.

### The question: who pays for startup

This tool mostly launches the target via `npx`. We once observed the same server take 3.3 seconds to start via npm but only 0.24 seconds via `node`. If you judge a server's speed from the wall clock (`elapsedMs`), those 3 seconds are really **npm's startup overhead**, yet they get charged to the server — and since the scoring has a "fast handshake +4" rule, a server started via `npm` can never earn it, making the `healthy` band effectively unreachable for the most-installed servers.

### The first hypothesis, and why it was wrong

Hypothesis: npm's overhead happens **before we write `initialize`**, so if we start the timer at the moment of writing, we exclude npm.

So we added `requestWrittenAt` to the probe, timing from write to response. Measured (`npx -y @modelcontextprotocol/server-sequential-thinking`):

```
     21ms  spawn returns
    139ms  initialize written
   5963ms  response arrives
```

The write does happen at 139ms; the response at 5963ms. The filesystem server is clearer — its startup banner appears at 4864ms, the response at 4881ms.

**Conclusion: the hypothesis was wrong.** npm's bootstrap isn't a "prelude before the write"; our write is buffered into its startup, and the whole overhead lands inside that one round trip. So "timing from the write" and "timing the wall clock" give the same number (measured 12098ms vs 12144ms) — nothing fixed.

### The right fix: arithmetic by launch path

The only reliable dividing line is the **launch method**. Same build artifact, three runs each of two launch methods:

```
via npx -y <pkg>     3445, 3399, 3502ms   avg 3449ms
via node <same file>  777,  717,  741ms   avg  745ms
                                     diff       2704ms
```

That 2704ms is npm, not the server — and it's **paid on every launch** (cold start 3544ms vs warm start 3552ms, showing it's bootstrap overhead, not download).

So the probe now reports three numbers:

| Field | Meaning | Counts toward score |
|---|---|---|
| `elapsedMs` | wall clock, including our own startup overhead | no |
| `launcherMs` | the part charged to npm/npx (constant 2500ms, floored to avoid over-penalizing) | — |
| `serverMs` | `elapsedMs − launcherMs` (only deducted when a launcher was actually used) | **yes** |

The constant 2500 can't be measured in a single run (the two overheads overlap, no in-band signal separates them), so it comes from the comparison experiment above. **Validation:** the same server launched via npm vs via node differs by only **122ms** in `serverMs` (659 vs 781) — showing the constant is fair.

### One sample isn't enough, so there's `--repeat`

The spread across three samples is large: the same server ranges from 585ms to 1630ms. Decide from a single result and the next run may flip on you.

So `--repeat <n>` was added (default 1, max 10). With multiple runs we take the **minimum**, not the average — noise is one-sided: a busy machine only **increases** latency, never decreases, so the fastest run is closest to the server's true cost; averaging would instead charge our own scheduler jitter to the server.

The threshold bands follow: with only 1 sample, you must be clearly under the line to get "fast handshake" (otherwise the next run flips); with 3+ samples, the minimum is a trustworthy estimate and scores accordingly. The report's wording changes too — single sample says "single sample," multiple says "3 runs, fastest taken," and it **never pretends a single sample can support a precise conclusion**.

### The result

After the fix, four official servers (`--repeat 3`):

| Server | 3 samples (`serverMs`) | Fastest | Verdict |
|---|---|---|---|
| server-memory | 644 / 617 / 602 | 602ms | **healthy 81** |
| server-sequential-thinking | 692 / 642 / 609 | 609ms | **healthy 81** |
| server-filesystem | 1254 / 988 / 687 | 687ms | usable 78 |
| server-everything | 1539 / 966 / 808 | 808ms | usable 78 |

Before the fix, all four were stuck in the 69–77 "usable" band. This was the **first time a real server earned "healthy"** — and it only could because sampling revealed their true cost is ~600ms; most of those 1500ms+ single numbers earlier were our own noise.

---

## How the trust score is computed

The score is a quantity you can **hand-check**, not a black box:

```
total = 60 (neutral starting point: "saw nothing in either direction")
      + sum of all matched signal weights
      then clamped to [0, 100]
```

The weight table lives in one place, `WEIGHTS` in `lib/trust.js`, 33 entries total, **kept in one spot so anyone can add it up themselves**. The main ones:

| Signal | Weight |
|---|---|
| `probe.spawn-error` (can't start) | −50 |
| `probe.no-handshake` (can't connect) | −45 |
| `probe.crash` (crashes) | −40 |
| `instructions.injection-shaped` (global instructions have an injection shape) | −35 |
| `probe.timeout` (hangs) | −30 |
| `tool-count.claimed-mismatch-large` (claimed vs measured tool count widely off) | −28 |
| `claims.install-hooks` (has **consumer-side** install script) | −20 |
| `tool.dangerous-description` (tool description has suspicious phrasing) | −18 |
| `claims.maintainer-hooks` (has maintainer-side script, disclosure only) | −1 |
| `good.recent-release` (released recently) | +8 |
| `good.tools-match` (claimed matches measured) | +6 |

The five bands:

| Band | Condition |
|---|---|
| healthy | passed probing, score ≥ 80 |
| usable (with items to note) | passed probing, score ≥ 60 |
| caution | score ≥ 35, or handshake OK but 0 tools |
| not recommended | score < 35 |
| unusable | probing could not be established |

**A few deliberate design trade-offs:**

- **No confident score without a probe.** `--offline` mode is fixed to the "usable" band, because metadata alone yields no runtime conclusion. The report says so explicitly: "static checks only (no server connection)."
- **No penalty when metadata isn't found.** Early versions penalized "no repo URL" / "no MCP marker," but when the target is **a bare script path**, it has no `package.json` to begin with — that's our input problem, not the server's. Penalizing the other side because our own check didn't run is exactly the kind of unfounded judgment this tool guards against, so it must not do it itself. This bug was caught by measurement (a clean server's score went from 59 to 67).
- **Never judges "clean" by "zero evidence = high score."** Neutral start at 60, raised only by positive observations.

---

## Why you can't spawn `npx` directly on Windows

On the first test against a real package, this tool **could not test a single real server** on Windows: static declarations read fine (it caught real npm metadata), but probing always returned `spawn-error: spawn npx ENOENT`.

After verifying each step with a real process, here's why:

| Attempt | Result |
|---|---|
| `spawn("npx")` no shell | `ENOENT` — only `npx.cmd` is on PATH, no extensionless executable |
| `spawn("npx.cmd")` no shell | `EINVAL` — hardened Windows refuses to exec `.cmd` directly without a shell |
| `spawn("npx", {shell:true})` | works, but re-introduces shell quoting/injection risk |

The fix is to **bypass both the shell and the `.cmd` wrapper**: locate npm's own CLI entry script (`node_modules/npm/bin/npx-cli.js`) and run it directly with `process.execPath`. This behaves identically on Linux/macOS and preserves the property that "the package name from the target never enters a shell."

After the fix the same server probed successfully at once: `status ok`, `mcp-servers/everything 2.0.0`, protocol `2025-11-25`, **14 tools**.

A related lesson: check the target path for **existence first** before handing it to node. Otherwise a typo'd path makes spawn succeed, node exits with `MODULE_NOT_FOUND`, and it gets reported as "the **server** crashed" — when in fact there was no server, just a wrong path. The fixes differ completely, so at the entry point you must separate "our input was wrong" from "their code is broken."

---

## Which risk patterns it recognizes

7 classes, applied to both **tool descriptions** and the server's global **`instructions`**. The criteria all come from public literature on tool poisoning: instructions hidden in tool descriptions enter the model context **at registration time**, before any call ever happens.

| Pattern | What it's looking for |
|---|---|
| `ignore-instructions` | phrasing like "ignore all previous instructions" |
| `exfiltrate` | "send credentials/secrets/env vars out" |
| `shell-hide` | "don't tell the user" |
| `metadata-fetch` | names a cloud metadata endpoint directly (`169.254.169.254`, etc.) |
| `read-secrets-path` | names a credentials file path (`~/.ssh`, `.aws/credentials`, `.env` …) |
| `always-approve` | "no confirmation needed / bypass approval" |
| `persona-override` | identity rewrites like "you are now…" |

**How these phrasings are written matters:** they describe "what was seen" and "why it's worth a look," and **do not accuse of malice**. A tool description telling the model what to do is normal; one telling it to ignore existing instructions is not. The report should make clear which kind was seen.

---

## What we don't test

**This is the most important section.** It's also the one printed unconditionally in the report.

| What's not tested | Why |
|---|---|
| **Behavior when tools are actually called** | The tool only does the handshake and `tools/list`; it executes no tool. A server can be perfectly well-behaved when not called, yet read files it shouldn't when a tool is called — exactly the common shape of indirect prompt injection. |
| **Code inside dependencies** | Only the dependency count is tallied, not their contents reviewed. Supply-chain risk often hides in transitive dependencies. |
| **Runtime network behavior** | No monitoring of which addresses the server connects to at runtime. A server can stay quiet during handshake and phone home on tool call. |
| **Runtime filesystem access** | Only `package.json` and the `README` were read; no observation of which files the server actually opened while running. |
| **Injection in tool return content** | Injection inside tool return values only appears when the tool is truly called. Detecting it needs a runtime gateway; static checks can't see it (that's exactly the job of tools like `mcp-sentry`). |
| **Source-code quality and logic correctness** | The implementation code was not read. A server with no security issues can still be functionally wrong. |

**In one sentence: finding no problem only means it passed the limited checks above — it does not mean it's safe.**

To view this list any time (no target needed):

```bash
npx mcp-server-inspector --coverage
```

---

## Install and usage

```bash
# run once, no install
npx mcp-server-inspector <target>

# or install globally
npm install -g mcp-server-inspector
mcpx <target>
```

Zero dependencies. Only needs Node ≥ 20. No config file, no daemon, no state — a "run it once before installing" tool shouldn't require you to configure anything first.

### Target syntax

```bash
mcpx @modelcontextprotocol/server-filesystem       # npm package name → auto via npx
mcpx ./my-mcp-server                                # local directory
mcpx "npx -y some-mcp-server --flag"                # full command line
mcpx ./dist/server.js                               # local script → launched with node
```

Two deliberate behaviors:

- **An explicitly written invocation is preserved verbatim.** Early versions re-wrapped `npx -y pkg` into `npx -y npx -y pkg` — that's fixed.
- **A missing local path errors on the spot**, rather than being handed to node. Otherwise you'd see a "server crashed" diagnosis with `MODULE_NOT_FOUND` — a wrong diagnosis: there's no server, just a wrong path. The report explicitly says "probe target does not exist (input problem, not a server problem)," so our own input error isn't charged to the other side.

### Options

| Option | Effect |
|---|---|
| `--offline` | don't connect to the server; static checks only (fast, but no runtime truth) |
| `--timeout <ms>` | probe timeout, default `15000` |
| `--repeat <n>` | repeat the probe a few times and use the fastest for the timing verdict (default `1`, max `10`). Single-sample timing is noisy; use `3` if the timing verdict matters |
| `--json` | output JSON (includes the `coverage` coverage note), good for CI |
| `--quiet` | suppress progress messages |
| `--coverage` | print the "tested / not tested" lists on their own |
| `-h, --help` / `-v, --version` | help / version |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | healthy / usable |
| `1` | caution / not recommended / unusable |
| `2` | usage error |

---

## Use it in code

```js
import { inspect } from "mcp-server-inspector";

const r = await inspect("@modelcontextprotocol/server-filesystem", {
  timeoutMs: 10000,
});

console.log(r.trust.band, r.trust.score);   // "healthy" 82
console.log(r.probe.status);                // "ok"
console.log(r.probe.toolCount);             // 14 (real count after full pagination)
console.log(r.claims.installScripts);       // [] (reported only, not executed)
console.log(r.trust.untested.length);       // 6 (the honesty list that always exists)
```

You can also take just the part you need:

```js
import { probe } from "mcp-server-inspector/probe";     // do the real-connect probe only
import { claimsFor } from "mcp-server-inspector/claims"; // read static metadata only
import { assess } from "mcp-server-inspector/trust";     // scoring only
import { render, toJson } from "mcp-server-inspector/report";
```

### JSON output structure

```json
{
  "tool": "mcp-server-inspector",
  "schemaVersion": 1,
  "target": "@scope/name",
  "probed": true,
  "package":  { "source": "npm", "name": "…", "installScripts": [], "…": "…" },
  "runtime":  { "status": "ok", "toolCount": 14, "tools": [], "exitCode": null },
  "verdict":  { "band": "healthy", "score": 82, "summary": "…" },
  "findings": [ { "id": "…", "severity": "…", "detail": "…", "evidence": "…", "weight": 0 } ],
  "coverage": {
    "tested":    [ "…" ],
    "notTested": [ { "id": "…", "title": "…", "why": "…" } ],
    "disclaimer": "No problems found ≠ safe.…"
  }
}
```

**Under `--offline`, `runtime` is `null`**, not an empty object — because there genuinely is no runtime observation to report. Consumers of this JSON should handle that case explicitly:

```json
{ "probed": false, "runtime": null, "verdict": { "band": "usable" } }
```

`coverage.notTested` and `coverage.disclaimer` **are always present**, including when everything is fine, and including when `runtime` is `null`. Anything consuming this JSON should pass them through.

---

## Development

```bash
npm test        # → node test/inspect.js
```

The tests have 290 assertions across 10 sections. A few deliberate practices:

- **The tests launch real child processes; `child_process` is never mocked.** `test/fixtures/` has two real servers: `good-server.js` is a spec-compliant implementation (toggles via argv: `--tools N`, `--paginate N`, `--instructions`, `--poisoned`, `--no-description`, `--no-schema`, `--no-annotations`); `broken-server.js` has 8 deliberately broken modes (`silent` / `crash` / `garbage` / `banner` / `empty` / `noresult` / `stagger` / `partial`).
- **Invariant-style assertions.** E.g. "every finding must carry an explanation," "the score must equal 60 plus the weight sum," "no runtime finding may appear when no probe ran," "the report must print section 3 unconditionally," "a server launched directly must not be granted the launcher discount it didn't pay for," "a crashed server must get neither a timing bonus nor an extra timing penalty." These assertions catch more bugs than line-by-line output diffs.
- **The `partial` mode splits one frame into two writes**, to prove the framing logic doesn't assume "one `data` event = one message" — a safe local assumption that breaks under load.
- **Section 5b specifically locks down timing isolation.** It regresses if: a server launched via npm loses points for someone else's overhead, the same server launched directly vs via npm scores inconsistently, the deducted `serverMs` goes negative or exceeds the wall clock, a single sample is given a borderline score on a whim, or the sample count isn't labeled truthfully.
- **Assert a phenomenon and you must put that phenomenon in the data.** We got this wrong once: testing "maintainer-side script only costs 1" by replacing rather than appending to `flags` also silently dropped two positive signals (`good.recent-release`, `good.multi-maintainer`), so the delta was 13 instead of 1 — **it looked like a code bug, but the test was wrong.** Printing the weights line by line is what located it. Suspect the code first, then suspect the test's expectations — but check both for real.

Zero-dependency ESM with JSDoc type annotations (`// @ts-check`).

---

## Honest boundaries (again)

`mcp-server-inspector` is a **minimum pre-admission health check**, not a security audit, not a quality certification, not a code review.

- **Passing ≠ safe.** It only means no obvious problem was observed during handshake and tool declaration.
- **Tool count ≠ capability.** 14 tools doesn't mean it can do 14 things, nor that it does them well.
- **Alive ≠ good.** A server can handshake cleanly and still be functionally wrong.
- **The score is a heuristic, not a measurement.** The weights are our choice — public, hand-checkable, and disagreeable. It ranks "how much it's worth a look," not "how safe."

The value of this tool isn't in giving a score; it's in **writing "what I know" and "what I don't know" separately and clearly.** If it does that, it's useful.

---

## Ecosystem data and sources

The ecosystem scale cited above comes from the following; verify it yourself:

- **MCP server count: 138,000+**, from the official MCP Registry (`registry.modelcontextprotocol.io`). The third-party list in the official `modelcontextprotocol/servers` repo has been superseded by that Registry.
- **That count relies on manual screening and categorization** — a 2026 ecosystem reference bakes criteria like "committed within the last 90 days" into its inclusion standard. Hundreds of thousands of packages screened by hand shows the tooling gap is real, which is exactly what this project was started to address.

Judgments about competitor shapes (e.g. the saturation of the Apple/macOS ecosystem) are observations from the research phase; they shift over time and are not taken as grounds for this tool's correctness.

---

## License

MIT
