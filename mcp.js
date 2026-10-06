#!/usr/bin/env bun
import config from "./src/mcp/tools.js";
import { runMcp } from "./src/mcp/runtime.js";

await runMcp(config);
