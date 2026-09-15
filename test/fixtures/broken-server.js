#!/usr/bin/env node
// @ts-check
/**
 * Deliberately broken MCP servers.
 *
 * Each failure mode is one that shows up in the wild, and each one has to be
 * distinguishable from the others in the report. If "it hung" and "it crashed"
 * produce the same output, the report cannot tell a user which problem they have,
 * and the tool has failed at the one thing it does.
 *
 * Modes:
 *   silent     starts, reads input, never answers. The classic hang.
 *   crash      exits immediately with a non-zero code.
 *   garbage    writes human text to stdout instead of protocol frames.
 *   banner     writes a banner line before the protocol, a very common real bug.
 *   empty      responds correctly but with zero tools.
 *   noresult   responds to initialize with an error object.
 *   stagger    answers initialize, then hangs on tools/list.
 *   partial    writes a valid frame split across two writes (framing test).
 */

const mode = process.argv[2] ?? "silent";

let buffer = "";
process.stdin.setEncoding("utf8");

switch (mode) {
  case "crash":
    process.stderr.write("fatal: missing required environment variable API_KEY\n");
    process.exit(3);
    break;

  case "garbage":
    process.stdout.write("Starting demo server v1.0.0\n");
    process.stdout.write("Listening on stdio...\n");
    process.stdin.on("data", () => {
      process.stdout.write("I do not speak JSON-RPC, sorry.\n");
    });
    break;

  case "banner":
    // A valid server that pollutes stdout with a banner first. This is legal-looking
    // to a lenient client and fatal to a strict one, which is exactly why it needs
    // its own mode: the report should call it out rather than treat it as garbage.
    process.stdout.write("demo-mcp-server ready\n");
    attach({ banner: true });
    break;

  case "empty":
    attach({ emptyTools: true });
    break;

  case "noresult":
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      drain((msg) => {
        if (msg.method === "initialize") {
          writeFrame({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "initialization refused" } });
        }
      });
    });
    break;

  case "stagger":
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      drain((msg) => {
        if (msg.method === "initialize") {
          writeFrame({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "stagger", version: "1.0.0" } },
          });
        }
        // tools/list is deliberately never answered.
      });
    });
    break;

  case "partial":
    // Writes each frame in two chunks with a delay, to prove the probe reassembles
    // frames across data events rather than assuming one chunk equals one message.
    attach({ splitWrites: true });
    break;

  case "silent":
  default:
    process.stdin.on("data", () => {
      /* read, ignore, live forever */
    });
    break;
}

/**
 * @param {{emptyTools?: boolean, banner?: boolean, splitWrites?: boolean}} opts
 */
function attach(opts) {
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    drain((msg) => {
      if (msg.method === "initialize") {
        writeFrame({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "broken-demo", version: "0.0.1" },
          },
        });
        return;
      }
      if (msg.method === "tools/list") {
        writeFrame({ jsonrpc: "2.0", id: msg.id, result: { tools: opts.emptyTools ? [] : [{ name: "only_tool", description: "The only tool.", inputSchema: { type: "object", properties: { a: { type: "string" } } } }] } });
      }
    });
  });
}

/**
 * @param {(msg: any) => void} onMsg
 */
function drain(onMsg) {
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      onMsg(JSON.parse(line));
    } catch {
      /* ignore malformed input from the probe */
    }
  }
}

/**
 * @param {any} obj
 */
function writeFrame(obj) {
  const text = JSON.stringify(obj) + "\n";
  if (text.length > 10 && process.env.SPLIT_WRITES === "1") {
    const mid = Math.floor(text.length / 2);
    process.stdout.write(text.slice(0, mid));
    setTimeout(() => process.stdout.write(text.slice(mid)), 5);
  } else {
    process.stdout.write(text);
  }
}
