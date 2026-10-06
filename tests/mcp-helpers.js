import { expect } from "bun:test";
import { join } from "node:path";
import { repo } from "./cli-helpers.js";

export { fixture, repo, startApp } from "./cli-helpers.js";

export const CLIENT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
export const CLIENT_INFO = { name: "mcp-tests", version: "0" };

export function isolatedEnv(dir) {
  return {
    NODE_ENV: "production",
    RSS_DATA_DIR: join(dir, "data"),
    RSS_ALLOW_PRIVATE: "1",
    DESIGN_DATA_DIR: join(dir, "data"),
    CODE_DIR: join(dir, "projects"),
    CODE_PROJECTS: "",
    MUSIC_DIR: join(dir, "media"),
    MUSIC_DATA_DIR: join(dir, "data"),
    VIDEOS_DIR: join(dir, "media"),
    VIDEOS_DATA_DIR: join(dir, "data"),
    PHOTOS_DIR: join(dir, "media"),
    PHOTOS_DATA_DIR: join(dir, "data"),
    NOTEBOOK_DATA_DIR: join(dir, "data"),
    NOTEBOOK_SHELL_CWD: dir,
    CALENDAR_DATA_DIR: join(dir, "data"),
    CHAT_BASE_URL: "http://127.0.0.1:1/v1",
  };
}

export async function post(url, message, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...CLIENT_HEADERS, ...headers },
    body: typeof message === "string" ? message : JSON.stringify(message),
  });
  const type = response.headers.get("Content-Type") || "";
  const text = await response.text();
  let value;
  if (type.includes("application/json") && text) value = JSON.parse(text);
  return {
    status: response.status,
    headers: response.headers,
    type,
    text,
    value,
  };
}

export function sseMessages(text) {
  return text
    .split("\n\n")
    .map((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

export function connect(baseUrl, path = "/mcp") {
  const url = baseUrl + path;
  const seen = new Set();
  let nextId = 1;
  const client = {
    url,
    seen,
    async request(method, params) {
      const { status, value } = await post(url, {
        jsonrpc: "2.0",
        id: nextId++,
        method,
        ...(params ? { params } : {}),
      });
      expect(status, `${method}: HTTP status`).toBe(200);
      return value;
    },
    async call(method, params) {
      const response = await client.request(method, params);
      expect(
        response.error,
        `${method}: ${JSON.stringify(response.error)}`,
      ).toBeUndefined();
      return response.result;
    },
    async initialize(protocolVersion = "2025-06-18") {
      const result = await client.call("initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      const { status } = await post(url, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      expect(status).toBe(202);
      return result;
    },
    async tools() {
      return (await client.call("tools/list")).tools;
    },
    async tool(name, args = {}, { expectError = false } = {}) {
      const result = await client.result(name, args);
      expect(
        Boolean(result.isError),
        `${name}: ${result.content?.[0]?.text || JSON.stringify(result)}`,
      ).toBe(expectError);
      return result.structuredContent ?? result;
    },
    async result(name, args = {}) {
      const result = await client.call("tools/call", { name, arguments: args });
      seen.add(name);
      return result;
    },
  };
  return client;
}

export function spawnMcp(args = [], { env = {}, cwd = repo } = {}) {
  const proc = Bun.spawn([process.execPath, join(repo, "mcp.js"), ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const waiters = new Map();
  const notifications = [];
  let nextId = 1;
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const waiter = waiters.get(message.id);
        if (waiter) {
          waiters.delete(message.id);
          waiter(message);
        } else notifications.push(message);
      }
    }
  })();
  return {
    proc,
    notifications,
    send(message) {
      proc.stdin.write(JSON.stringify(message) + "\n");
      proc.stdin.flush();
    },
    request(method, params) {
      const id = nextId++;
      const reply = new Promise((resolve) => waiters.set(id, resolve));
      this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      return reply;
    },
    async call(method, params) {
      const response = await this.request(method, params);
      expect(
        response.error,
        `${method}: ${JSON.stringify(response.error)}`,
      ).toBeUndefined();
      return response.result;
    },
    async close() {
      proc.stdin.end();
      const code = await proc.exited;
      await reading;
      return { code, stderr: await stderr };
    },
  };
}

export function expectApiRoundTrip(result, label = "tool") {
  expect(result.content?.[0]?.type, `${label}: content`).toBe("text");
  if (result.isError)
    expect(
      result.structuredContent?.status,
      `${label}: ${result.content[0].text}`,
    ).toBeGreaterThan(0);
}

export function readOnlyTool(tools) {
  return tools.find(
    (tool) =>
      !(tool.inputSchema.required || []).length &&
      tool.annotations?.readOnlyHint,
  );
}
