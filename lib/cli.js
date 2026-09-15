// @ts-check
/**
 * CLI.
 *
 * One command with one job: inspect a target and print a report. There is no
 * configuration file, no daemon, no state. A tool people run once before deciding
 * to install something should not ask them to set anything up first.
 */

import { inspect } from "./index.js";
import { render, toJson, BAND_LABEL } from "./report.js";
import { UNTESTED } from "./trust.js";

const VERSION = "0.1.0";

const HELP = `
mcp-server-inspector v${VERSION}

在把一个 MCP 服务器接进 agent 之前，先搞清楚你到底知道它什么。

它做三件事：
  1. 真连上去，跟它握手，问它到底暴露哪些工具（不是读 README 猜）
  2. 读它的静态声明（依赖、安装脚本、许可证、发版时间、维护者）
  3. 把两者的差距、以及它能读到的风险模式，写成一份报告

报告分三段：事实 / 判断 / 没测什么。第三段无条件打印，因为
「没发现问题」和「安全」是两件事。

用法
  mcpx inspect <目标> [选项]

目标可以是
  包名          @modelcontextprotocol/server-filesystem
  本地目录      ./my-mcp-server
  命令行        "npx -y some-mcp-server --flag"

选项
  --offline          不连接服务器，只做静态检查（快，但看不到运行时真相）
  --timeout <毫秒>   探测超时，默认 15000
  --repeat <次数>    重复探测几次，取最快的一次做耗时判断（默认 1，最多 10）
                     单次计时有噪声；在意耗时结论时用 3
  --json             输出 JSON（含 coverage 覆盖范围说明）
  --quiet            不打印进度提示
  --no-color         关闭颜色（本版本默认无颜色）
  -h, --help         显示本帮助
  -v, --version      显示版本

退出码
  0  健康 / 可用
  1  需谨慎 / 不建议 / 无法使用
  2  用法错误

示例
  mcpx inspect @modelcontextprotocol/server-filesystem
  mcpx inspect ./my-server --timeout 5000
  mcpx inspect "npx -y @some/mcp-server" --json > report.json
  mcpx inspect some-package --offline

它不做的事（重要）
  它不调用任何工具，不运行包里的代码，不监控网络，不读源码。
  它不能告诉你这个服务器在工具被真正调用时的行为。
  完整清单见报告第三节，或 mcpx --coverage
`.trim();

/**
 * @param {string[]} argv
 * @returns {{flags: Record<string, string|boolean>, positionals: string[]}}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positionals = [];
  const valueFlags = new Set(["timeout", "repeat"]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) {
        flags[key] = a.slice(eq + 1);
      } else if (valueFlags.has(key)) {
        const next = argv[i + 1];
        if (next === undefined) throw new Error(`--${key} 需要一个值`);
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (a === "-h") {
      flags.help = true;
    } else if (a === "-v") {
      flags.version = true;
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

/**
 * Print the untested list on its own, without needing a target. Exists because
 * "what does this tool not check?" is a question worth being able to answer before
 * running anything, and because it makes the limitation impossible to miss.
 * @returns {number}
 */
function cmdCoverage() {
  const L = [];
  L.push("");
  L.push("mcp-server-inspector 的检查范围");
  L.push("=".repeat(68));
  L.push("");
  L.push("会检查:");
  for (const t of [
    "stdio 握手（initialize）是否成功",
    "工具清单（tools/list，含分页遍历）",
    "工具描述与参数 schema 中的风险模式",
    "服务器全局 instructions 中的风险模式",
    "包的静态元数据（依赖数、装包即执行的脚本、许可证、仓库）",
    "npm 发版时间与维护者数量（在线模式）",
  ]) {
    L.push(`  · ${t}`);
  }
  L.push("");
  L.push("不会检查:");
  for (const u of UNTESTED) {
    L.push(`  · ${u.title}`);
    L.push(`      ${u.why}`);
  }
  L.push("");
  L.push("结论：本工具是「准入前的最低限度体检」，不是安全审计。");
  L.push("      它通过只说明它没有明显的、可在握手阶段观测到的问题。");
  L.push("");
  process.stdout.write(L.join("\n"));
  return 0;
}

/**
 * @returns {Promise<number>}
 */
async function main() {
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const { flags, positionals } = parsed;

  if (flags.help === true) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (flags.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (flags.coverage === true) return cmdCoverage();

  // Command word is optional: `mcpx <target>` and `mcpx inspect <target>` both work,
  // because a user who types a package name means inspect.
  let target = "";
  if (positionals[0] === "inspect") target = positionals.slice(1).join(" ");
  else target = positionals.join(" ");

  if (target.trim() === "") {
    process.stdout.write(HELP + "\n");
    return 2;
  }

  const timeoutRaw = typeof flags.timeout === "string" ? Number(flags.timeout) : 15000;
  if (!Number.isFinite(timeoutRaw) || timeoutRaw < 500) {
    process.stderr.write("--timeout 需要一个不小于 500 的毫秒数\n");
    return 2;
  }
  const repeatRaw = typeof flags.repeat === "string" ? Number(flags.repeat) : 1;
  if (!Number.isInteger(repeatRaw) || repeatRaw < 1 || repeatRaw > 10) {
    process.stderr.write("--repeat 需要 1 到 10 之间的整数\n");
    return 2;
  }

  try {
    const report = await inspect(target, {
      probe: flags.offline !== true,
      timeoutMs: timeoutRaw,
      quiet: flags.quiet === true,
      repeat: repeatRaw,
    });

    if (flags.json === true) {
      process.stdout.write(toJson(report) + "\n");
    } else {
      process.stdout.write(render(report));
      process.stdout.write(`\n（详细覆盖范围：mcpx --coverage）\n\n`);
    }
    return report.exitCode;
  } catch (err) {
    process.stderr.write(`检查失败: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
}

export { main, parseArgs, HELP, VERSION, cmdCoverage, BAND_LABEL };
