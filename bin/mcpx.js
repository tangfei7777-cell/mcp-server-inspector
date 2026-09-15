#!/usr/bin/env node
// @ts-check
import { main } from "../lib/cli.js";

main().then((code) => {
  process.exitCode = code;
});
