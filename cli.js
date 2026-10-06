#!/usr/bin/env bun
import config from "./src/cli/commands.js";
import { runCli } from "./src/cli/runtime.js";

await runCli(config);
