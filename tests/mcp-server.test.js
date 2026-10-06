import { expect, test } from "bun:test";
import config from "../src/mcp/tools.js";
import { compileTools } from "../src/mcp/runtime.js";
import {
  CLIENT_INFO,
  connect,
  expectApiRoundTrip,
  fixture,
  isolatedEnv,
  readOnlyTool,
  spawnMcp,
  startApp,
} from "./mcp-helpers.js";

test("the API-only server answers MCP at /mcp with every tool", async () => {
  const files = await fixture();
  let app;
  try {
    app = await startApp(files.dir);
    const client = connect(app.baseUrl);
    const init = await client.initialize();
    expect(init.serverInfo.name).toBe(config.app);
    expect(init.protocolVersion).toBe("2025-06-18");
    const tools = await client.tools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      compileTools(config)
        .map((t) => t.name)
        .sort(),
    );
    expect((await fetch(app.baseUrl + "/mcp")).status).toBe(405);
    expect((await fetch(app.baseUrl + "/")).status).toBe(404);
  } finally {
    await app?.stop();
    await files.cleanup();
  }
}, 30000);

test("the web server serves the page and MCP side by side", async () => {
  const files = await fixture();
  let app;
  try {
    app = await startApp(files.dir, { HEADLESS: "0" });
    const page = await fetch(app.baseUrl + "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    const client = connect(app.baseUrl);
    await client.initialize();
    const tool = readOnlyTool(await client.tools());
    expect(tool).toBeTruthy();
    expectApiRoundTrip(await client.result(tool.name), tool.name);
  } finally {
    await app?.stop();
    await files.cleanup();
  }
}, 30000);

test("mcp.js --start runs its own API-only server for the session and stops it after", async () => {
  const files = await fixture();
  const mcp = spawnMcp(["--start"], { env: isolatedEnv(files.dir) });
  try {
    const init = await mcp.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    expect(init.serverInfo.name).toBe(config.app);
    mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const { tools } = await mcp.call("tools/list");
    expect(tools).toHaveLength(config.commands.length);
    const tool = readOnlyTool(tools);
    const result = await mcp.call("tools/call", {
      name: tool.name,
      arguments: {},
    });
    expectApiRoundTrip(result, tool.name);
    const { code, stderr } = await mcp.close();
    expect(code).toBe(0);
    const port = stderr.match(/http:\/\/localhost:(\d+)/)?.[1];
    expect(port).toBeTruthy();
    await expect(fetch(`http://127.0.0.1:${port}/api/`)).rejects.toThrow();
  } finally {
    mcp.proc.kill();
    await files.cleanup();
  }
}, 30000);
