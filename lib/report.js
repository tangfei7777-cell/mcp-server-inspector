// @ts-check
/**
 * Report rendering.
 *
 * Structural decision, and the reason this file exists as its own module: the
 * report is split into three sections that must never be merged.
 *
 *   事实     What was measured. Reproducible by anyone who runs the same command.
 *   判断     What we make of it. Arguable, and traced to the facts above.
 *   没测什么 What this run does NOT cover.
 *
 * The third section is the one that makes the first two trustworthy. A tool that
 * reports "no problems found" without saying where it looked is inviting its reader
 * to over-trust it, and over-trusting a supply-chain check is how people get
 * compromised. So the untested list is printed unconditionally - not on request, not
 * only when something fails, and not folded into a footnote.
 */

/**
 * @typedef {import("./trust.js").TrustReport} TrustReport
 * @typedef {import("./probe.js").ProbeResult} ProbeResult
 */

const BAND_LABEL = {
  healthy: "健康",
  usable: "可用（有需留意项）",
  caution: "需谨慎",
  avoid: "不建议使用",
  unusable: "无法使用",
};

const SEV_LABEL = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
  info: "说明",
  good: "正面",
};

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 5, good: 4 };

/**
 * Render the human-readable report.
 *
 * @param {object} o
 * @param {string} o.target
 * @param {ProbeResult} o.probe
 * @param {any} o.claims
 * @param {TrustReport} o.trust
 * @param {boolean} o.probed
 * @param {{maxRows?: number}} [opts]
 * @returns {string}
 */
function render(o, opts) {
  const maxRows = opts?.maxRows ?? 20;
  const { target, probe, claims, trust, probed } = o;
  const L = [];

  L.push("");
  L.push(`MCP 服务器体检报告`);
  L.push(`目标: ${target}`);
  if (claims?.name) L.push(`包名: ${claims.name}${claims.version ? "@" + claims.version : ""}`);
  L.push("=".repeat(68));
  L.push("");
  L.push(`结论: ${BAND_LABEL[trust.band] ?? trust.band}   综合分 ${trust.score}/100`);
  L.push("");
  L.push(wrap(trust.summary, 66));
  L.push("");

  // ---- Section 1: facts -----------------------------------------------------
  L.push("-".repeat(68));
  L.push("一、事实（可复现的观测，谁跑都一样）");
  L.push("-".repeat(68));
  L.push("");
  if (probed) {
    const statusText = {
      ok: "握手成功",
      "no-handshake": "未完成握手",
      "no-tools": "握手成功但未暴露工具",
      crash: "进程自行退出",
      timeout: "超时无响应",
      "not-json": "输出不是合法协议消息",
      "spawn-error": "进程无法启动",
    }[probe.status] ?? probe.status;
    L.push(`  运行状态      ${statusText}`);
    if (probe.statusDetail) L.push(`                ${wrap(probe.statusDetail, 62, "                ")}`);
    if (probe.serverName) L.push(`  服务器自述    ${probe.serverName} ${probe.serverVersion ?? ""}`);
    if (probe.protocolVersion) L.push(`  协议版本      ${probe.protocolVersion}`);
    L.push(`  暴露工具数    ${probe.toolCount}${probe.pages > 1 ? `（分 ${probe.pages} 页返回）` : ""}`);
    // Two numbers, deliberately. The server's own cost is what the score reasons
    // about; the wall clock is reported for context but labelled with what it
    // actually measures. Printing one number would invite the reader to attribute
    // npm's bootstrap to the server - measured at 2704ms on a single artifact,
    // npm 3449ms vs direct node 745ms - which is the mistake this split corrects.
    if (typeof probe.serverMs === "number" && probe.serverMs > 0) {
      const samples = probe.timingRuns ?? 1;
      L.push(`  服务器耗时    ${probe.serverMs}ms${samples > 1 ? `（${samples} 次采样取最快）` : "（单次采样）"}  ← 评分依据`);
    }
    if (probe.launcherMs > 0) {
      L.push(`  启动器开销    ${probe.launcherMs}ms（npm/npx 本身，已从评分中扣除）`);
    }
    L.push(`  本次总耗时    ${probe.elapsedMs}ms（墙钟，含我们这边的启动开销）`);
    L.push(`  退出码        ${probe.exitCode === null ? "（未退出，由探针终止）" : probe.exitCode}`);
    if (probe.tools.length > 0) {
      L.push("");
      L.push("  工具清单:");
      for (const t of probe.tools.slice(0, maxRows)) {
        const ann = (t.annotations ?? []).length > 0 ? ` [${t.annotations.join(",")}]` : "";
        const desc = t.description ? t.description.replace(/\s+/g, " ").slice(0, 60) : "(无描述)";
        L.push(`    · ${t.name}${ann}`);
        L.push(`        ${desc}`);
      }
      if (probe.tools.length > maxRows) L.push(`    ...还有 ${probe.tools.length - maxRows} 个`);
    }
    if (probe.stderrLines.length > 0) {
      L.push("");
      L.push("  服务器 stderr（前几行）:");
      for (const s of probe.stderrLines.slice(0, 5)) L.push(`    ${s}`);
    }
  } else {
    L.push("  （本次未连接服务器，无运行时观测。用 --offline 之外的默认模式可执行连接。）");
  }
  L.push("");

  if (claims && claims.source !== "unknown") {
    L.push(`  静态声明来源  ${claims.source === "npm" ? "npm registry" : "本地目录"}`);
    if (claims.description) L.push(`  自述          ${wrap(claims.description, 62, "                ")}`);
    L.push(`  许可证        ${claims.license ?? "（未声明）"}`);
    L.push(`  仓库          ${claims.repository ?? "（未声明）"}`);
    L.push(`  直接依赖      ${claims.depCount}${claims.devDepCount ? `（另 ${claims.devDepCount} 个开发依赖）` : ""}`);
    L.push(`  可执行入口    ${(claims.binNames ?? []).join(", ") || "（无）"}`);
    // Scripts are reported in two lines on purpose: they have different threat
    // models, and merging them hid that difference.
    const consumerHooks = claims.consumerInstallScripts ?? [];
    const maintainerHooks = claims.maintainerScripts ?? [];
    L.push(
      `  装包即执行    ${consumerHooks.length > 0 ? consumerHooks.join(", ") + "  ← 使用者安装时自动运行" : "无（使用者安装时不会执行任何脚本）"}`,
    );
    if (maintainerHooks.length > 0) {
      L.push(`  维护端脚本    ${maintainerHooks.join(", ")}（只在维护者构建/发布时运行）`);
    }
    L.push(`  README 提及工具 ${claims.readmeToolCount} 个`);
    if ((claims.errors ?? []).length > 0) {
      L.push(`  静态读取问题  ${claims.errors.join("; ")}`);
    }
  }
  L.push("");

  // ---- Section 2: judgement -------------------------------------------------
  L.push("-".repeat(68));
  L.push("二、判断（基于上面的事实，可以不同意）");
  L.push("-".repeat(68));
  L.push("");

  const problems = trust.findings.filter((f) => f.severity !== "good").sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const positives = trust.findings.filter((f) => f.severity === "good");

  if (problems.length === 0) {
    L.push("  本次检查没有发现需要提示的问题。");
    L.push("  注意这只覆盖了下方「三、没测什么」里列出的范围之外的部分。");
  } else {
    for (const f of problems.slice(0, maxRows)) {
      L.push(`  [${SEV_LABEL[f.severity]}] ${f.title}`);
      L.push(`      ${wrap(f.detail, 62, "      ")}`);
      if (f.evidence) L.push(`      依据: ${wrap(f.evidence, 60, "            ")}`);
      L.push("");
    }
    if (problems.length > maxRows) L.push(`  ...还有 ${problems.length - maxRows} 项，用 --json 看全部\n`);
  }

  if (positives.length > 0) {
    L.push("  正面信号:");
    for (const f of positives) L.push(`    · ${f.title} —— ${f.evidence || f.detail}`);
    L.push("");
  }

  // ---- Section 3: what was NOT tested ---------------------------------------
  L.push("-".repeat(68));
  L.push("三、没测什么（这一节比上面两节都重要）");
  L.push("-".repeat(68));
  L.push("");
  L.push("  本工具只做握手 + tools/list，不调用任何工具、不运行包代码、不监控网络。");
  L.push("  以下内容完全没有覆盖：");
  L.push("");
  for (const u of trust.untested) {
    L.push(`  · ${u.title}`);
    L.push(`      ${wrap(u.why, 62, "      ")}`);
  }
  L.push("");
  L.push("  换句话说：没有发现问题，只代表它通过了上述有限几项检查，");
  L.push("  不代表它是安全的。");
  L.push("");
  return L.join("\n");
}

/**
 * Machine-readable report. Carries an explicit `coverage` block so a consumer
 * cannot read `findings: []` as "clean" without also seeing the scope limit.
 *
 * @param {object} o
 * @param {string} o.target
 * @param {ProbeResult} o.probe
 * @param {any} o.claims
 * @param {TrustReport} o.trust
 * @param {boolean} o.probed
 * @returns {string}
 */
function toJson(o) {
  const { target, probe, claims, trust, probed } = o;
  return JSON.stringify(
    {
      tool: "mcp-server-inspector",
      schemaVersion: 1,
      target,
      probed,
      package: claims
        ? {
            source: claims.source,
            name: claims.name ?? null,
            version: claims.version ?? null,
            license: claims.license ?? null,
            repository: claims.repository ?? null,
            dependencyCount: claims.depCount ?? 0,
            installScripts: claims.installScripts ?? [],
            consumerInstallScripts: claims.consumerInstallScripts ?? [],
            maintainerScripts: claims.maintainerScripts ?? [],
            readmeToolCount: claims.readmeToolCount ?? 0,
            errors: claims.errors ?? [],
          }
        : null,
      runtime: probed
        ? {
            status: probe.status,
            statusDetail: probe.statusDetail,
            serverName: probe.serverName ?? null,
            serverVersion: probe.serverVersion ?? null,
            protocolVersion: probe.protocolVersion,
            toolCount: probe.toolCount,
            pages: probe.pages,
            elapsedMs: probe.elapsedMs,
            serverMs: probe.serverMs ?? null,
            launcherMs: probe.launcherMs ?? 0,
            handshakeMs: probe.handshakeMs ?? null,
            usedLauncher: probe.usedLauncher ?? false,
            timingRuns: probe.timingRuns ?? 1,
            timingSamples: probe.timingSamples ?? null,
            exitCode: probe.exitCode,
            exitedOnItsOwn: probe.exitedOnItsOwn,
            tools: probe.tools.map((t) => ({ name: t.name, description: t.description, annotations: t.annotations ?? [] })),
            stderr: probe.stderrLines,
            notes: probe.notes ?? [],
          }
        : null,
      verdict: { band: trust.band, score: trust.score, summary: trust.summary },
      findings: trust.findings,
      coverage: {
        tested: [
          "stdio 握手（initialize）",
          "工具清单（tools/list，含分页）",
          "工具描述与参数 schema 的静态风险模式",
          "服务器全局 instructions 的静态风险模式",
          "包的静态元数据（依赖数、装包即执行的脚本、许可证、仓库）",
          "npm 发版时间与维护者数量（在线模式）",
        ],
        notTested: trust.untested.map((u) => ({ id: u.id, title: u.title, why: u.why })),
        disclaimer:
          "未发现问题 ≠ 安全。本报告只覆盖上述 tested 范围内的检查；notTested 中列出的内容完全没有验证。",
      },
    },
    null,
    2,
  );
}

/**
 * Exit code contract.
 *
 *   0 - healthy or usable
 *   1 - caution, avoid, or unusable
 *   2 - usage error (raised by the CLI)
 *
 * Nothing critical is distinguished from merely worrying here. This tool is used
 * at a decision point ("do I install this?"), not in a build gate, so any real
 * problem should surface the same way: non-zero, and the human reads the report.
 *
 * @param {TrustReport} trust
 * @returns {0|1}
 */
function exitCodeFor(trust) {
  return trust.band === "caution" || trust.band === "avoid" || trust.band === "unusable" ? 1 : 0;
}

/**
 * Wrap text to a width, respecting the CJK convention that a full-width character
 * is twice as wide as a Latin one. Without this, Chinese paragraphs render ragged
 * next to ASCII identifiers.
 *
 * @param {string} text
 * @param {number} width
 * @param {string} [indent]
 * @returns {string}
 */
function wrap(text, width, indent = "") {
  const s = String(text ?? "");
  if (s === "") return "";
  const lines = [];
  let cur = "";
  let curW = 0;
  for (const ch of s) {
    const w = isWide(ch) ? 2 : 1;
    if (curW + w > width && cur !== "") {
      lines.push(cur);
      cur = "";
      curW = 0;
    }
    cur += ch;
    curW += w;
  }
  if (cur) lines.push(cur);
  return lines.join("\n" + indent);
}

/**
 * Rough East Asian width check. Covers the ranges that actually appear in these
 * reports: CJK, full-width forms, and CJK punctuation.
 *
 * @param {string} ch
 * @returns {boolean}
 */
function isWide(ch) {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

export { render, toJson, exitCodeFor, wrap, isWide, BAND_LABEL, SEV_LABEL };
