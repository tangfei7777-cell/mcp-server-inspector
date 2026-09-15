// @ts-check
/**
 * Trust assessment: turn observations into a judgement, and be explicit about the
 * parts of the judgement that are not supported by evidence.
 *
 * The design rule for this file: every point of the score traces to a named
 * finding, and every finding traces to an observation. If a signal cannot be
 * observed, it is not scored - it is listed as untested. A score that cannot be
 * decomposed is a number someone made up, and a supply-chain score that nobody can
 * argue with is worse than no score, because people act on it.
 *
 * The second design rule: absence of evidence is not evidence of safety. A package
 * with no install hooks, no suspicious tool descriptions, and a recent release has
 * passed the checks we ran. It has not been proven safe, and the report says so in
 * its own section rather than burying it.
 */

/**
 * @typedef {import("./probe.js").ProbeResult} ProbeResult
 * @typedef {import("./claims.js").StaticClaims} ClaimFlag
 */

/**
 * @typedef {object} Finding
 * @property {string} id
 * @property {"critical"|"high"|"medium"|"low"|"good"} severity
 * @property {string} title
 * @property {string} detail
 * @property {string} evidence    What was observed, quoted or counted.
 * @property {number} weight      Negative for problems, positive for good signs.
 */

/**
 * @typedef {object} TrustReport
 * @property {number} score            0-100, higher is better.
 * @property {"healthy"|"usable"|"caution"|"avoid"|"unusable"} band
 * @property {Finding[]} findings
 * @property {{id:string, title:string, why:string}[]} untested
 * @property {number} passed
 * @property {number} failed
 * @property {string} summary
 */

/**
 * Weight table. Kept in one place so the total is auditable by hand, which was a
 * deliberate choice: a reader who wants to check the arithmetic should be able to.
 */
const WEIGHTS = {
  "probe.ok": 0,
  "probe.no-handshake": -45,
  "probe.no-tools": -20,
  "probe.crash": -40,
  "probe.timeout": -30,
  "probe.not-json": -25,
  "probe.spawn-error": -50,
  "probe.slow": -5,
  "probe.died-early": -10,
  "probe.stdout-pollution": -8,
  "tool-count.claimed-mismatch": -12,
  "tool-count.claimed-mismatch-large": -28,
  "tool-count.zero-claimed-some": -20,
  "tool.dangerous-description": -18,
  "tool.undocumented": -4,
  "tool.no-schema": -6,
  "instructions.injection-shaped": -35,
  "instructions.length": -3,
  "claims.install-hooks": -20,
  "claims.maintainer-hooks": -1,
  "claims.no-license": -4,
  "claims.no-repository": -6,
  "claims.dep-heavy": -6,
  "claims.single-maintainer": -3,
  "claims.stale": -14,
  "claims.very-stale": -26,
  "claims.no-mcp-marker": -5,
  "good.recent-release": 8,
  "good.multi-maintainer": 4,
  "good.clean-install": 5,
  "good.tools-match": 6,
  "good.fast-handshake": 4,
  "good.low-dependency": 3,
  "good.has-annotations": 3,
};

/**
 * Description patterns that indicate a tool may be trying to use the model rather
 * than serve it. These come from the tool-poisoning literature: instructions hidden
 * in tool descriptions enter the model's context at registration time, before any
 * call is made.
 *
 * Note the wording of the `why` strings throughout: they describe what was seen and
 * why it is worth a look. They do not assert malice. A tool description telling the
 * model what to do is normal; a tool description telling the model to ignore prior
 * instructions is not, and the report should say which one it saw.
 */
const DESCRIPTION_RISKS = [
  {
    id: "ignore-instructions",
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)\b/i,
    what: "工具描述里出现「忽略之前所有指令」这类措辞",
    why: "正常的工具描述只说明自己做什么。要求模型丢弃既有指令，是把工具描述当成指令通道来用。",
  },
  {
    id: "exfiltrate",
    re: /\b(?:send|post|upload|transmit|forward|exfiltrate)\b[\s\S]{0,40}\b(?:credentials?|secrets?|tokens?|keys?|passwords?|env(?:ironment)?\s*vars?|\.env)\b/i,
    what: "工具描述里出现「把凭证/密钥/环境变量发送出去」的措辞",
    why: "这是数据外泄的字面描述。合法工具不会把「偷偷把密钥发走」写进自己的说明。",
  },
  {
    id: "shell-hide",
    re: /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|notify|mention|reveal)\b[\s\S]{0,30}\b(?:user|human|operator)\b/i,
    what: "工具描述里出现「不要告诉用户」这类措辞",
    why: "要求对使用者保密，与工具应有的可观察性直接冲突。",
  },
  {
    id: "metadata-fetch",
    re: /\b(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200)\b/,
    what: "工具描述里直接出现云 metadata 端点地址",
    why: "这些地址提供云主机凭证。正常工具不需要在描述里指名它们。",
  },
  {
    id: "read-secrets-path",
    re: /(?:~\/\.ssh|\.aws\/credentials|\.npmrc|\.netrc|id_rsa|\.env\b)/,
    what: "工具描述里指名凭证文件路径",
    why: "工具是否该读这些文件取决于其用途；一个不相关的工具提到它们值得留意。",
  },
  {
    id: "always-approve",
    re: /\b(?:auto[- ]?approve|no\s+confirmation|without\s+(?:asking|confirmation|approval)|bypass\s+(?:approval|permission))/i,
    what: "工具描述里出现「无需确认/绕过审批」这类措辞",
    why: "工具可以请求敏感权限，但不该自行宣告审批流程不适用。",
  },
  {
    id: "persona-override",
    re: /\byou\s+are\s+now\b|\bnew\s+(?:persona|identity)\b|\bact\s+as\s+(?:a\s+)?(?:different|another)\b/i,
    what: "工具描述里出现「你现在是…」这类角色改写措辞",
    why: "工具描述不该重新定义模型的身份。",
  },
];

/**
 * Signals we did not measure. Listed explicitly so a reader can tell the difference
 * between "we checked and it was fine" and "we never looked".
 *
 * This list is the honest core of the tool. A score without it implies a
 * completeness that no static-plus-handshake inspection can deliver.
 */
const UNTESTED = [
  {
    id: "runtime-behaviour",
    title: "工具被真正调用时的行为",
    why:
      "本工具只做握手和 tools/list，不执行任何工具。一个服务器可以在不调用工具时完全规矩，" +
      "而在工具被真正调用时读取不该读的文件——这正是间接提示注入的常见形态。",
  },
  {
    id: "dependency-contents",
    title: "依赖包内部的代码",
    why: "只统计了依赖数量，没有审查依赖的内容。供应链风险往往藏在传递依赖里。",
  },
  {
    id: "network-behaviour",
    title: "运行时网络行为",
    why: "没有监控服务器在运行时会连向哪些地址。一个服务器可以在握手阶段安静，在工具调用时外联。",
  },
  {
    id: "filesystem-access",
    title: "运行时文件系统访问",
    why: "只读了 package.json 和 README，没有观察服务器运行期间实际打开了哪些文件。",
  },
  {
    id: "prompt-injection-runtime",
    title: "工具返回内容中的注入",
    why:
      "工具返回值里的注入内容只有真正调用时才会出现。这类检测需要运行时网关，" +
      "静态检查看不到（这正是 mcp-sentry 那类工具的职责）。",
  },
  {
    id: "code-review",
    title: "源代码质量与逻辑正确性",
    why: "没有阅读实现代码。一个没有安全问题的服务器仍可能功能是错的。",
  },
];

/**
 * Score a probe + claims pair.
 *
 * @param {object} input
 * @param {ProbeResult} input.probe
 * @param {any} input.claims
 * @param {boolean} [input.probed]  False when the probe was skipped (offline mode).
 * @returns {TrustReport}
 */
function assess(input) {
  const { probe, claims } = input;
  const probed = input.probed !== false;
  /** @type {Finding[]} */
  const findings = [];

  const add = (/** @type {string} */ id, /** @type {Omit<Finding,"weight">} */ f) => {
    // A finding without an explanation is not auditable: the reader cannot tell
    // whether the score moved for a good reason. Empty details are a real bug
    // class here, because several findings forward a `why` string that comes
    // from a claim flag and can legitimately be empty. Catch it at the source
    // rather than trusting every call site to have remembered.
    const detail =
      typeof f.detail === "string" && f.detail.trim().length > 0
        ? f.detail
        : `这条判断来自 ${id}，但该信号没有附带解释。这属于工具缺陷，请在仓库里报告。`;
    findings.push({ ...f, detail, weight: WEIGHTS[id] ?? 0 });
  };

  // ---- Probe outcome --------------------------------------------------------
  if (probed) {
    switch (probe.status) {
      case "ok":
        break;
      case "no-handshake":
        add("probe.no-handshake", {
          id: "probe.no-handshake",
          severity: "critical",
          title: "服务器没有完成初始化握手",
          detail: "它启动了，但对 initialize 请求没有给出合法响应。这样的服务器接进任何客户端都用不了。",
          evidence: probe.statusDetail,
        });
        break;
      case "no-tools":
        add("probe.no-tools", {
          id: "probe.no-tools",
          severity: "high",
          title: "服务器握手正常，但一个工具都没有暴露",
          detail: "它能连上，但 tools/list 返回空。如果它对外宣称提供能力，这个宣称与实际不符。",
          evidence: probe.statusDetail,
        });
        break;
      case "crash":
        add("probe.crash", {
          id: "probe.crash",
          severity: "critical",
          title: "服务器在探测过程中自行退出",
          detail: `它在响应完成前就退出了（退出码 ${probe.exitCode}）。`,
          evidence: probe.statusDetail + (probe.stderrLines.length ? ` | stderr: ${probe.stderrLines.slice(0, 3).join(" / ")}` : ""),
        });
        break;
      case "timeout":
        add("probe.timeout", {
          id: "probe.timeout",
          severity: "high",
          title: "服务器没有在超时内响应",
          detail: "它没有退出，也没有回答。真实客户端里这会表现为永久卡住。",
          evidence: `${probe.elapsedMs}ms 无响应`,
        });
        break;
      case "not-json":
        add("probe.not-json", {
          id: "probe.not-json",
          severity: "high",
          title: "服务器输出不是合法的协议消息",
          detail: "按 stdio 传输要求，stdout 必须是换行分隔的 JSON-RPC。收到的不是。",
          evidence: probe.statusDetail,
        });
        break;
      case "spawn-error":
        add("probe.spawn-error", {
          id: "probe.spawn-error",
          severity: "critical",
          // Distinguish "your input was wrong" from "their code is broken".
          // Both are fatal to the probe, but only one of them is about the server.
          title: /路径不存在|does not exist|ENOENT/i.test(probe.statusDetail ?? "")
            ? "探测目标不存在（输入问题，不是服务器问题）"
            : "服务器无法启动",
          detail: /路径不存在|does not exist|ENOENT/i.test(probe.statusDetail ?? "")
            ? "没有找到这个路径，所以没有任何东西被启动。请检查路径是否写对——这不代表服务器有问题。"
            : "进程根本没能拉起来。",
          evidence: probe.statusDetail,
        });
        break;
    }

    if (probe.status === "ok") {
      // Grade the server's own cost, never the wall clock.
      //
      // Why this is not the same number: when the target is an npm package we run it
      // through npm's CLI, and npm's bootstrap lands inside the handshake round trip
      // rather than before it - our write is buffered into its startup. Measured on
      // one identical artifact, npm launch 3449ms vs direct node launch 745ms: a
      // 2704ms charge that belongs to npm, paid again on every launch.
      //
      // Grading the wall clock meant no npm-launched server could ever earn the
      // fast-handshake credit, which made the whole `healthy` band unreachable for
      // exactly the servers users actually install. `probe.serverMs` carries that
      // correction; the fallback keeps hand-built result objects working.
      const ms = typeof probe.serverMs === "number" && probe.serverMs > 0 ? probe.serverMs : probe.elapsedMs;
      const note = probe.launcherMs > 0 ? `（已扣除 npm/npx 启动开销 ${probe.launcherMs}ms，这个数字只反映服务器本身。）` : "";
      // A single timing sample is noisy on a shared machine - measured spreads of
      // 585ms to 1630ms for the same server across consecutive runs. The margin
      // therefore depends on how many samples the number rests on:
      //
      //   1 sample  - withhold the credit unless it is well clear of the band edge,
      //               because the next run could easily land over it
      //   3+ samples- the minimum of several runs is a real estimate; grade it
      //
      // Without this, the only honest options were to over-claim on one sample or to
      // never award the credit at all. Sampling is the actual fix; the margin is just
      // how the tool stays truthful when the caller did not ask for samples.
      const samples = probe.timingRuns ?? 1;
      const margin = samples >= 3 ? 0 : 1000;
      const sampleNote = samples > 1 ? `${samples} 次取最快` : "单次采样";
      if (ms < 1500 - margin) {
        add("good.fast-handshake", {
          id: "good.fast-handshake",
          severity: "good",
          title: "握手很快",
          detail: `服务器本身约 ${ms}ms 就完成了握手，不会拖慢客户端。${note}`,
          evidence: `${ms}ms（${sampleNote}）`,
        });
      } else if (ms > 8000) {
        add("probe.slow", {
          id: "probe.slow",
          severity: "low",
          title: "握手偏慢",
          detail: `扣除启动器开销后，服务器本身仍需约 ${ms}ms 才完成握手，这会在每次会话开始时累积成可感知的等待。${note}`,
          evidence: `${ms}ms（${sampleNote}）`,
        });
      }
    }

    if (probe.exitedOnItsOwn) {
      add("probe.died-early", {
        id: "probe.died-early",
        severity: "medium",
        title: "服务器在探测中途自行退出",
        detail: "不是被我们终止的，是它自己退出的。这在长时间会话里通常意味着不稳定。",
        evidence: `退出码 ${probe.exitCode}`,
      });
    }

    if (probe.notes && probe.notes.length > 0) {
      add("probe.stdout-pollution", {
        id: "probe.stdout-pollution",
        severity: "medium",
        title: "stdout 上出现了非协议内容",
        detail:
          "stdio 传输下 stdout 是协议通道。往里打印日志或 banner 会干扰客户端解析，" +
          "在宽松的客户端里可能表现正常，在严格的客户端里会直接失败。",
        evidence: probe.notes.slice(0, 2).join(" | "),
      });
    }
  }

  // ---- Claimed vs actual tool count ----------------------------------------
  const claimed = claims?.readmeToolCount ?? 0;
  const actual = probe?.toolCount ?? 0;
  if (probed && probe.status === "ok") {
    if (claimed >= 3 && actual === 0) {
      add("tool-count.zero-claimed-some", {
        id: "tool-count.zero-claimed-some",
        severity: "high",
        title: `README 提到 ${claimed} 个工具，实际暴露 0 个`,
        detail: "宣称的能力在实测中不存在。可能是版本不一致，也可能是 README 写的是计划中的能力。",
        evidence: `README 提到: ${claims.readmeToolNames.slice(0, 8).join(", ")}${claimed > 8 ? " …" : ""}`,
      });
    } else if (claimed >= 5 && actual < claimed * 0.5) {
      add("tool-count.claimed-mismatch-large", {
        id: "tool-count.claimed-mismatch-large",
        severity: "medium",
        title: `README 提到 ${claimed} 个工具，实际暴露 ${actual} 个（差 ${claimed - actual}）`,
        detail:
          "差距超过一半。常见原因是 README 未随版本更新、工具被配置项隐藏、或 README 描述的是整个项目而非这个服务器。",
        evidence: `README 提到: ${claims.readmeToolNames.slice(0, 10).join(", ")}`,
      });
    } else if (claimed >= 3 && actual < claimed) {
      add("tool-count.claimed-mismatch", {
        id: "tool-count.claimed-mismatch",
        severity: "low",
        title: `README 提到 ${claimed} 个工具，实际暴露 ${actual} 个`,
        detail: "小幅差异通常无害，可能只是文档滞后。",
        evidence: `差 ${claimed - actual} 个`,
      });
    } else if (claimed >= 3 && actual >= claimed) {
      add("good.tools-match", {
        id: "good.tools-match",
        severity: "good",
        title: "宣称的工具数与实际一致",
        detail: `README 提到 ${claimed} 个，实测暴露 ${actual} 个。`,
        evidence: `${actual} >= ${claimed}`,
      });
    }
  }

  // ---- Per-tool findings ----------------------------------------------------
  if (probed && Array.isArray(probe.tools)) {
    for (const t of probe.tools) {
      for (const risk of DESCRIPTION_RISKS) {
        if (risk.re.test(t.description)) {
          add("tool.dangerous-description", {
            id: `tool.dangerous-description:${t.name}:${risk.id}`,
            severity: "high",
            title: `工具 "${t.name}" 的描述里有可疑措辞`,
            detail: risk.why,
            evidence: `命中模式「${risk.what}」: ${clip(t.description, 200)}`,
          });
        }
      }
      if (!t.description || t.description.trim().length < 10) {
        add("tool.undocumented", {
          id: `tool.undocumented:${t.name}`,
          severity: "low",
          title: `工具 "${t.name}" 几乎没有描述`,
          detail:
            "模型只能靠描述判断该不该用这个工具。描述为空时，模型会在不该用的时候用它，" +
            "或者完全不用它。",
          evidence: t.description ? `描述长度 ${t.description.trim().length}` : "无描述",
        });
      }
      const schema = t.inputSchema;
      const propCount = schema && typeof schema === "object" && schema.properties ? Object.keys(schema.properties).length : 0;
      if (propCount === 0 && (!schema || schema.type !== "object" || Object.keys(schema).length === 0)) {
        add("tool.no-schema", {
          id: `tool.no-schema:${t.name}`,
          severity: "low",
          title: `工具 "${t.name}" 没有参数 schema`,
          detail: "没有 schema，调用方无法知道该传什么，只能猜。",
          evidence: JSON.stringify(schema ?? {}).slice(0, 120),
        });
      }
    }

    const withAnnotations = probe.tools.filter((t) => (t.annotations ?? []).length > 0).length;
    if (probe.tools.length > 0 && withAnnotations === probe.tools.length) {
      add("good.has-annotations", {
        id: "good.has-annotations",
        severity: "good",
        title: "所有工具都带了行为标注",
        detail: "标注（如 readOnlyHint/destructiveHint）能让客户端在调用前给出更准确的提示。",
        evidence: `${withAnnotations}/${probe.tools.length}`,
      });
    }
  }

  // ---- Server-level instructions -------------------------------------------
  if (probed && probe.instructions && probe.instructions.length > 0) {
    for (const risk of DESCRIPTION_RISKS) {
      if (risk.re.test(probe.instructions)) {
        add("instructions.injection-shaped", {
          id: `instructions.injection-shaped:${risk.id}`,
          severity: "critical",
          title: "服务器的全局 instructions 里有注入形状的措辞",
          detail:
            "initialize 返回的 instructions 会进入模型上下文，作用和工具描述相当。" +
            "这里的措辞更值得警惕，因为它作用于整个会话而不只是某次调用。" + risk.why,
          evidence: `命中模式「${risk.what}」: ${clip(probe.instructions, 300)}`,
        });
      }
    }
    if (probe.instructions.length > 4000) {
      add("instructions.length", {
        id: "instructions.length",
        severity: "low",
        title: `全局 instructions 很长（${probe.instructions.length} 字符）`,
        detail: "这段文字每次会话都会占用上下文。过长时既有 token 成本，也更容易夹带内容。",
        evidence: `长度 ${probe.instructions.length}`,
      });
    }
  }

  // ---- Static claims --------------------------------------------------------
  if (claims && Array.isArray(claims.flags)) {
    for (const f of claims.flags) {
      if (f.id === "install-hooks") {
        add("claims.install-hooks", {
          id: "claims.install-hooks",
          severity: "high",
          title: f.what,
          detail:
            f.why ||
            "安装期脚本会在 npm install 时自动执行，不需要任何确认。" +
              "这意味着装这个包等同于运行它的代码。这不是说它一定有问题，而是说信任门槛必须更高：值得先读过脚本再装。",
          evidence: (claims.installScripts ?? []).map((/** @type {string} */ h) => `${h}: ${claims.scripts?.[h]}`).join(" | "),
        });
      } else if (f.id === "maintainer-hooks") {
        // Deliberately informational: these scripts run in the maintainer's tree,
        // not on a consumer's machine. Reporting them at the same weight as a
        // postinstall hook flagged nearly every TypeScript package - including
        // the MCP project's own reference server - and made the score useless.
        add("claims.maintainer-hooks", {
          id: "claims.maintainer-hooks",
          severity: "info",
          title: f.what,
          detail:
            f.why ||
            "这些脚本只在维护者自己的安装/发布流程里执行，不在使用者安装时执行，因此不是消费端执行面。",
          evidence: (claims.maintainerScripts ?? []).map((/** @type {string} */ h) => `${h}: ${claims.scripts?.[h]}`).join(" | "),
        });
      } else if (f.id === "no-license") {
        add("claims.no-license", {
          id: "claims.no-license",
          severity: "low",
          title: f.what,
          detail: f.why || "没有 license 字段，使用和再分发的法律边界不明确。",
          evidence: "package.json 无 license 字段",
        });
      } else if (f.id === "dep-heavy") {
        add("claims.dep-heavy", {
          id: "claims.dep-heavy",
          severity: "low",
          title: f.what,
          detail: f.why || "依赖越多，供应链暴露面越大——任何一个传递依赖出问题都会传导过来。",
          evidence: `${claims.depCount} 个直接依赖`,
        });
      } else if (f.id === "npm.maintainers") {
        const count = /(\d+)/.exec(f.what)?.[1];
        if (count === "1") {
          add("claims.single-maintainer", {
            id: "claims.single-maintainer",
            severity: "low",
            title: f.what,
            detail: f.why || "只有一个维护者时，发版节奏和响应安全问题都取决于一个人。这不代表有问题，但意味着项目可能随时停更。",
            evidence: f.what,
          });
        } else if (count && Number(count) >= 3) {
          add("good.multi-maintainer", {
            id: "good.multi-maintainer",
            severity: "good",
            title: f.what,
            detail: f.why || "多人维护通常意味着发版更持续、单点失效风险更低。",
            evidence: f.what,
          });
        }
      } else if (f.id === "npm.age") {
        const ageMatch = /(\d+)\s*天前/.exec(f.what);
        const age = ageMatch ? Number(ageMatch[1]) : 0;
        if (age > 730) {
          add("claims.very-stale", {
            id: "claims.very-stale",
            severity: "high",
            title: `超过两年没有新版本`,
            detail: f.why || "两年没有新版本，通常意味着项目已经停更。协议在演进，停更的服务器会慢慢和新客户端对不上。",
            evidence: f.what,
          });
        } else if (age > 365) {
          add("claims.stale", {
            id: "claims.stale",
            severity: "medium",
            title: `超过一年没有新版本`,
            detail: f.why || "一年没有新版本，可能是项目已经稳定，也可能是没人维护了。装之前值得去仓库看一眼最近有没有人回 issue。",
            evidence: f.what,
          });
        } else if (age < 90) {
          add("good.recent-release", {
            id: "good.recent-release",
            severity: "good",
            title: "最近有发版",
            detail: f.why || "三个月内有发版，说明项目还在维护。",
            evidence: f.what,
          });
        }
      }
    }
  }

  // Metadata findings are only meaningful when metadata was actually read. When
  // the target is a bare script path there is no package.json and no README, so
  // "no repository" and "no MCP marker" are statements about our own input, not
  // about the server. Penalising a server for a check that never ran is the
  // precise failure mode this tool exists to catch, so it must not commit it.
  const hasMetadata = claims && claims.source !== "unknown" && claims.source !== undefined && claims.source !== null;
  if (hasMetadata) {
    if (!claims.repository) {
      add("claims.no-repository", {
        id: "claims.no-repository",
        severity: "low",
        title: "没有公开仓库地址",
        detail: "没有仓库就无从核对源码，也无法判断这是不是一个已经停更的项目。",
        evidence: "package.json 无 repository 字段",
      });
    }
    if ((claims.mcpHints ?? []).length === 0) {
      add("claims.no-mcp-marker", {
        id: "claims.no-mcp-marker",
        severity: "low",
        title: "元数据里找不到 MCP 相关标记",
        detail: "包名、关键词、依赖里都没有 MCP 痕迹。可能装错了包，也可能这个包并没有声明自己是 MCP 服务器。",
        evidence: "未命中 modelcontextprotocol / mcp 关键词",
      });
    }
    if ((claims.depCount ?? 0) <= 3) {
      add("good.low-dependency", {
        id: "good.low-dependency",
        severity: "good",
        title: "依赖很少",
        detail: "依赖少意味着供应链暴露面小，也更容易审计。",
        evidence: `${claims.depCount} 个直接依赖`,
      });
    }
  }

  // ---- Total ----------------------------------------------------------------
  let score = 60; // Neutral starting point: "nothing observed either way".
  for (const f of findings) score += f.weight;
  score = Math.max(0, Math.min(100, score));

  // A probe that never ran cannot support a confident score at all. Saying so is
  // more useful than emitting a number derived purely from metadata.
  const band = !probed
    ? "usable"
    : probe.status !== "ok"
      ? probe.status === "no-tools"
        ? "caution"
        : "unusable"
      : score >= 80
        ? "healthy"
        : score >= 60
          ? "usable"
          : score >= 35
            ? "caution"
            : "avoid";

  const bad = findings.filter((f) => f.severity === "critical" || f.severity === "high");
  const good = findings.filter((f) => f.severity === "good");

  const summary = buildSummary({ probed, probe, band, bad, good, score });

  return {
    score,
    band,
    findings,
    untested: UNTESTED,
    passed: good.length,
    failed: bad.length,
    summary,
  };
}

/**
 * @param {object} o
 * @param {boolean} o.probed
 * @param {ProbeResult} o.probe
 * @param {string} o.band
 * @param {Finding[]} o.bad
 * @param {Finding[]} o.good
 * @param {number} o.score
 * @returns {string}
 */
function buildSummary({ probed, probe, band, bad, good, score }) {
  if (!probed) {
    return "只做了静态检查（未连接服务器），因此没有验证它是否能真正运行，也没有验证它暴露哪些工具。";
  }
  if (probe.status === "spawn-error") return "服务器无法启动，无法进行任何运行时验证。";
  if (probe.status !== "ok" && probe.status !== "no-tools") {
    return "服务器未能完成握手，运行时验证不成立。";
  }
  const parts = [];
  if (band === "healthy") parts.push("实测通过，未发现明显问题。");
  else if (band === "usable") parts.push("实测通过，有一些值得留意的地方。");
  else if (band === "caution") parts.push("发现需要人工判断的问题。");
  else parts.push("发现较严重的问题。");
  if (bad.length > 0) parts.push(`其中 ${bad.length} 项属于高危及以上。`);
  if (good.length > 0) parts.push(`另有 ${good.length} 项正面信号。`);
  parts.push(`综合分 ${score}/100。`);
  parts.push("注意：本报告只覆盖握手与工具声明，未覆盖工具被真正调用时的行为。");
  return parts.join("");
}

/**
 * @param {string} s
 * @param {number} n
 * @returns {string}
 */
function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export { assess, WEIGHTS, DESCRIPTION_RISKS, UNTESTED };
