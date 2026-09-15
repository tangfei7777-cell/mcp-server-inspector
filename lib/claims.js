// @ts-check
/**
 * Static claims: what the package says about itself.
 *
 * This layer reads the package's own metadata without executing it. That is a
 * meaningful limitation and it is stated everywhere it matters: everything here is
 * a *claim*, not a fact. The facts come from the probe.
 *
 * The comparison between the two is the most useful thing this tool produces. A
 * package claiming twenty tools that exposes three is not necessarily dishonest -
 * versions drift, the README may be aspirational, the server may gate tools behind
 * configuration - but it is a discrepancy, and discrepancies are what a person
 * about to install something needs to see.
 *
 * Nothing in this file executes package code. Reading package.json is safe; running
 * a package to see what it does is not, which is why the probe spawns but never
 * installs, and why install scripts are reported as a finding rather than run.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * @typedef {object} StaticClaims
 * @property {"local"|"npm"|"unknown"} source
 * @property {string} target
 * @property {string} [name]
 * @property {string} [version]
 * @property {string} [description]
 * @property {string} [license]
 * @property {string} [repository]
 * @property {string[]} binNames
 * @property {string[]} mcpHints
 * @property {number} depCount
 * @property {number} devDepCount
 * @property {string} [engines]
 * @property {Record<string,string>} scripts
 * @property {string[]} installScripts   All lifecycle scripts present. Named, not run.
 * @property {string[]} consumerInstallScripts  Runs on a consumer's machine at install.
 * @property {string[]} maintainerScripts       Runs only in the maintainer's tree.
 * @property {ClaimFlag[]} flags
 * @property {string[]} readmeToolNames  Tool names mentioned in the README, if found.
 * @property {number} readmeToolCount
 * @property {string[]} errors
 */

/**
 * @typedef {object} ClaimFlag
 * @property {string} id
 * @property {"info"|"warn"|"risk"} level
 * @property {string} what
 * @property {string} why
 */

/**
 * Lifecycle scripts, split by where they actually execute.
 *
 * These are not equivalent and must not be reported as if they were:
 *
 *   consumer  - runs on a *consumer's* machine during `npm install`. This is the
 *               real supply-chain surface: installing the package executes code.
 *               (postinstall is the classic vector; preinstall/install likewise.)
 *   publish   - `prepare` runs on `npm install` inside the package's own dev tree
 *               and before publishing, and `prepublishOnly` only on publish. These
 *               are maintainer-side build steps. They do not run on a consumer's
 *               machine when the package is installed from the registry.
 *
 * Lumping them together produced a false alarm on essentially every TypeScript
 * package, including the MCP project's own reference server. Measured against
 * @modelcontextprotocol/server-everything, the conflation alone cost 20 points
 * and pushed the official reference implementation to "caution".
 */
const CONSUMER_INSTALL_HOOKS = ["preinstall", "install", "postinstall"];
const MAINTAINER_HOOKS = ["prepare", "prepublishOnly"];
const INSTALL_HOOKS = [...CONSUMER_INSTALL_HOOKS, ...MAINTAINER_HOOKS];

/**
 * Read claims from a local directory.
 *
 * @param {string} dir
 * @returns {StaticClaims}
 */
function claimsFromDir(dir) {
  const pkgPath = join(dir, "package.json");
  /** @type {StaticClaims} */
  const claims = {
    source: "local",
    target: dir,
    binNames: [],
    mcpHints: [],
    depCount: 0,
    devDepCount: 0,
    scripts: {},
    installScripts: [],
    consumerInstallScripts: [],
    maintainerScripts: [],
    flags: [],
    readmeToolNames: [],
    readmeToolCount: 0,
    errors: [],
  };

  if (!existsSync(pkgPath)) {
    claims.errors.push("no package.json in this directory");
    readReadme(dir, claims);
    return claims;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    claims.errors.push(`package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return claims;
  }

  applyPackageJson(pkg, claims);
  readReadme(dir, claims);
  return claims;
}

/**
 * Fetch claims from the npm registry. Read-only, no code execution.
 *
 * Separated from the local reader because the two answer different questions: a
 * local directory tells you what is here now, the registry tells you what everyone
 * else is getting and when it last changed.
 *
 * @param {string} name
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [opts]
 * @returns {Promise<StaticClaims>}
 */
async function claimsFromRegistry(name, opts) {
  const timeoutMs = opts?.timeoutMs ?? 10000;
  const doFetch = opts?.fetchImpl ?? fetch;
  /** @type {StaticClaims} */
  const claims = {
    source: "npm",
    target: name,
    name,
    binNames: [],
    mcpHints: [],
    depCount: 0,
    devDepCount: 0,
    scripts: {},
    installScripts: [],
    consumerInstallScripts: [],
    maintainerScripts: [],
    flags: [],
    readmeToolNames: [],
    readmeToolCount: 0,
    errors: [],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(`https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      claims.errors.push(`registry returned ${res.status}`);
      return claims;
    }
    const doc = await res.json();
    const latest = doc?.["dist-tags"]?.latest;
    const version = latest ? doc?.versions?.[latest] : undefined;

    if (typeof doc?.name === "string") claims.name = doc.name;
    if (typeof latest === "string") claims.version = latest;
    if (typeof doc?.description === "string") claims.description = doc.description;
    if (typeof doc?.license === "string") claims.license = doc.license;
    if (typeof doc?.repository?.url === "string") claims.repository = doc.repository.url;

    // Publication timing. Recency is the single most predictive signal for whether
    // a package is still cared for, and unlike star counts it cannot be gamed.
    const times = doc?.time ?? {};
    if (typeof times.created === "string" && typeof times.modified === "string") {
      const ageDays = daysBetween(times.modified, new Date());
      const totalDays = daysBetween(times.created, new Date());
      claims.flags.push({
        id: "npm.age",
        level: ageDays > 365 ? "warn" : "info",
        what: `最近发版 ${times.modified.slice(0, 10)}（${Math.round(ageDays)} 天前），首次发布 ${times.created.slice(0, 10)}`,
        why:
          ageDays > 365
            ? "一年多没有新版本。MCP 协议本身在演进，长期不更新的服务器可能已经跟不上当前规范。"
            : `总共 ${Math.round(totalDays)} 天的发版历史。`,
      });
    }
    if (Array.isArray(doc?.maintainers)) {
      claims.flags.push({
        id: "npm.maintainers",
        level: doc.maintainers.length === 1 ? "warn" : "info",
        what: `维护者 ${doc.maintainers.length} 人`,
        why:
          doc.maintainers.length === 1
            ? "单一维护者。不是问题本身，但意味着一旦此人停更，包就没人接手了。"
            : "多人维护，交接风险较低。",
      });
    }

    if (version && typeof version === "object") {
      applyPackageJson(version, claims);
    }
    return claims;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    claims.errors.push(/abort/i.test(msg) ? `registry request timed out after ${timeoutMs}ms` : msg);
    return claims;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply the common package.json fields to a claims object. Shared between the
 * local reader and the registry reader so the two can never drift apart - a
 * divergence there would make the local-vs-registry comparison meaningless.
 *
 * @param {any} pkg
 * @param {StaticClaims} claims
 */
function applyPackageJson(pkg, claims) {
  if (typeof pkg?.name === "string") claims.name = pkg.name;
  if (typeof pkg?.version === "string") claims.version = pkg.version;
  if (typeof pkg?.description === "string" && !claims.description) claims.description = pkg.description;
  if (typeof pkg?.license === "string") claims.license = pkg.license;
  const repo = pkg?.repository;
  if (typeof repo === "string") claims.repository = repo;
  else if (typeof repo?.url === "string") claims.repository = repo.url;

  const bin = pkg?.bin;
  if (typeof bin === "string") claims.binNames = [pkg.name];
  else if (bin && typeof bin === "object") claims.binNames = Object.keys(bin);

  if (typeof pkg?.engines?.node === "string") claims.engines = pkg.engines.node;

  if (pkg?.dependencies && typeof pkg.dependencies === "object") {
    claims.depCount = Object.keys(pkg.dependencies).length;
  }
  if (pkg?.devDependencies && typeof pkg.devDependencies === "object") {
    claims.devDepCount = Object.keys(pkg.devDependencies).length;
  }
  if (pkg?.scripts && typeof pkg.scripts === "object") {
    claims.scripts = {};
    for (const [k, v] of Object.entries(pkg.scripts)) {
      if (typeof v === "string") claims.scripts[k] = v;
    }
  }

  claims.installScripts = INSTALL_HOOKS.filter((h) => typeof claims.scripts[h] === "string");
  claims.consumerInstallScripts = CONSUMER_INSTALL_HOOKS.filter((h) => typeof claims.scripts[h] === "string");
  claims.maintainerScripts = MAINTAINER_HOOKS.filter((h) => typeof claims.scripts[h] === "string");

  // Look for MCP markers anywhere in the manifest. A package that is not obviously
  // an MCP server is a legitimate finding: the user may have the wrong package.
  const hay = JSON.stringify(pkg).toLowerCase();
  const hints = new Set();
  if (hay.includes("modelcontextprotocol")) hints.add("depends on @modelcontextprotocol/sdk");
  if (hay.includes("mcp")) hints.add("mentions mcp in metadata");
  if (typeof pkg?.keywords === "object" && Array.isArray(pkg.keywords)) {
    if (pkg.keywords.some((k) => String(k).toLowerCase() === "mcp")) hints.add("has the 'mcp' keyword");
  }
  claims.mcpHints = [...hints];

  const consumerHooks = claims.consumerInstallScripts ?? [];
  const maintainerHooks = claims.maintainerScripts ?? [];

  if (consumerHooks.length > 0) {
    claims.flags.push({
      id: "install-hooks",
      level: "risk",
      what: `声明了消费端安装脚本: ${consumerHooks.join(", ")}`,
      why:
        "这些脚本会在你（或任何使用者）npm install 这个包时自动执行，不需要任何确认——装它等于运行它的代码。" +
        "这不等于有问题，很多包合法地用它做原生模块编译；但它是供应链攻击最常见的落点，装之前值得先读过脚本内容。本工具只报告，不运行。",
    });
  } else if (maintainerHooks.length > 0) {
    // Separate finding, deliberately much weaker. `prepare` and `prepublishOnly`
    // run in the maintainer's own tree, not on a consumer's machine.
    claims.flags.push({
      id: "maintainer-hooks",
      level: "info",
      what: `声明了维护端脚本: ${maintainerHooks.join(", ")}`,
      why:
        "这些脚本在维护者自己安装/发布时执行，不在使用者 npm install 时执行，所以不构成消费端执行面。" +
        "列出来只是因为它们说明这个包需要一个构建步骤（常见于 TypeScript 项目）。",
    });
  }
  if (claims.depCount > 50) {
    claims.flags.push({
      id: "dep-heavy",
      level: "warn",
      what: `直接依赖 ${claims.depCount} 个`,
      why: "依赖越多，供应链暴露面越大。对 MCP 服务器这类需要读取敏感数据的组件，这个数字值得留意。",
    });
  }
  if (!claims.license) {
    claims.flags.push({
      id: "no-license",
      level: "warn",
      what: "package.json 里没有 license 字段",
      why: "没有明确许可证意味着你默认没有使用授权，即使代码是公开的。",
    });
  }
  if (claims.engines && !satisfiesNode(claims.engines)) {
    claims.flags.push({
      id: "engine-mismatch",
      level: "warn",
      what: `要求 Node ${claims.engines}，当前 ${process.version}`,
      why: "版本要求与当前运行时不符，安装后可能无法启动。",
    });
  }
}

/**
 * Read the README and pull out any tool names it advertises.
 *
 * Pattern matched: tool names usually appear in tables or bullet lists as
 * backticked identifiers, or as MCP tool-call examples. The extraction is
 * deliberately conservative - a wrong extraction would create a phantom
 * discrepancy, which is exactly the kind of false alarm that discredits an audit.
 *
 * @param {string} dir
 * @param {StaticClaims} claims
 */
function readReadme(dir, claims) {
  const candidates = ["README.md", "readme.md", "Readme.md", "README.MARKDOWN"];
  let text = "";
  for (const c of candidates) {
    const p = join(dir, c);
    if (existsSync(p) && statSync(p).isFile()) {
      try {
        text = readFileSync(p, "utf8");
        break;
      } catch {
        // unreadable README is not worth failing over
      }
    }
  }
  if (!text) return;

  const names = new Set();

  // Markdown table rows: "| `tool_name` | description |"
  for (const m of text.matchAll(/^\|\s*`([a-z][a-z0-9_]{2,40})`/gm)) names.add(m[1]);

  // Bullet entries: "- `tool_name` - description"
  for (const m of text.matchAll(/^[-*]\s+`([a-z][a-z0-9_]{2,40})`/gm)) names.add(m[1]);

  // Explicit tool listings: "- tool_name: description" inside a Tools section.
  for (const m of text.matchAll(/^\s*(?:[-*]|\d+\.)\s+([a-z][a-z0-9_]{2,40})\s*[:—–-]\s+\S/gm)) names.add(m[1]);

  // Drop obvious non-tool words that show up in every README.
  const noise = new Set([
    "install", "usage", "example", "examples", "license", "license", "npm", "npx", "yarn",
    "pnpm", "node", "note", "notes", "warning", "config", "configuration", "options",
    "tools", "tool", "features", "feature", "requirements", "contributing", "development",
    "test", "tests", "build", "version", "changelog", "credits", "authors", "author",
  ]);
  const found = [...names].filter((n) => !noise.has(n));

  claims.readmeToolNames = found;
  claims.readmeToolCount = found.length;
}

/**
 * Loose check of an engines range against the running Node. Intentionally
 * approximate: it only needs to catch gross mismatches, and a false warning here
 * would be noise.
 *
 * @param {string} range
 * @returns {boolean}
 */
function satisfiesNode(range) {
  const cur = process.versions.node.split(".").map(Number);
  const min = /(?:>=|\^|~)?\s*(\d+)(?:\.(\d+))?/.exec(range);
  if (!min) return true;
  const wantMajor = Number(min[1]);
  const wantMinor = min[2] !== undefined ? Number(min[2]) : 0;
  if (cur[0] > wantMajor) return true;
  if (cur[0] < wantMajor) return false;
  return cur[1] >= wantMinor;
}

/**
 * @param {string} iso
 * @param {Date} now
 * @returns {number} days, possibly fractional
 */
function daysBetween(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return (now.getTime() - t) / 86400000;
}

/**
 * Resolve a target string to claims, choosing local vs registry by shape.
 *
 * @param {string} target
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [opts]
 * @returns {Promise<StaticClaims>}
 */
async function claimsFor(target, opts) {
  const t = String(target ?? "").trim();
  if (t === "") throw new Error("empty target");
  if (existsSync(t) && statSync(t).isDirectory()) {
    return claimsFromDir(resolve(t));
  }
  if (/^@?[\w.-]+(?:\/[\w.-]+)?$/.test(t) && !/[\\/]/.test(t.replace(/^@[^/]+\//, ""))) {
    return claimsFromRegistry(t, opts);
  }
  return {
    source: "unknown",
    target: t,
    binNames: [],
    mcpHints: [],
    depCount: 0,
    devDepCount: 0,
    scripts: {},
    installScripts: [],
    consumerInstallScripts: [],
    maintainerScripts: [],
    flags: [],
    readmeToolNames: [],
    readmeToolCount: 0,
    errors: ["target is neither an existing directory nor a plain package name; static claims unavailable"],
  };
}

export {
  claimsFor,
  claimsFromDir,
  claimsFromRegistry,
  applyPackageJson,
  readReadme,
  satisfiesNode,
  INSTALL_HOOKS,
};
