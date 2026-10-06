import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import appConfig from "../src/mcp/tools.js";
import {
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  compileTools,
  createMcpHttpHandler,
  validateArguments,
} from "../src/mcp/runtime.js";
import {
  CLIENT_INFO,
  connect,
  fixture,
  post,
  readOnlyTool,
  repo,
  spawnMcp,
  sseMessages,
} from "./mcp-helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=",
  "base64",
);

const fixtureConfig = {
  app: "fixture",
  instructions: "Fixture instructions.",
  commands: [
    {
      name: "echo get",
      method: "GET",
      path: "/api/echo/:id",
      query: ["q", "flag", "path"],
      description: "Echo a GET.",
    },
    {
      name: "echo post",
      method: "POST",
      path: "/api/echo",
      body: "json",
      description: "Echo a JSON body.",
    },
    {
      name: "echo optional",
      method: "POST",
      path: "/api/echo",
      body: "json?",
      description: "Echo an optional body.",
    },
    {
      name: "upload",
      method: "POST",
      path: "/api/upload",
      body: "multipart",
      description: "Upload files.",
    },
    {
      name: "raw",
      method: "POST",
      path: "/api/echo",
      body: "bytes",
      query: ["path"],
      description: "Upload bytes.",
    },
    {
      name: "png",
      method: "GET",
      path: "/api/png",
      description: "A small image.",
    },
    {
      name: "big",
      method: "GET",
      path: "/api/big",
      query: ["chunked"],
      description: "A large image.",
    },
    { name: "text", method: "GET", path: "/api/text", description: "Text." },
    {
      name: "blob",
      method: "GET",
      path: "/api/blob",
      description: "Opaque bytes.",
    },
    {
      name: "error",
      method: "GET",
      path: "/api/error",
      description: "An API error.",
    },
    {
      name: "partial",
      method: "GET",
      path: "/api/partial",
      query: ["some"],
      description: "Partial failure.",
    },
    {
      name: "cell",
      method: "GET",
      path: "/api/cell-error",
      description: "A failed cell run.",
    },
    {
      name: "slow",
      method: "GET",
      path: "/api/slow",
      query: ["ms"],
      description: "Slow.",
    },
    {
      name: "empty",
      method: "DELETE",
      path: "/api/empty",
      description: "No content.",
    },
    {
      name: "chat",
      method: "POST",
      path: "/api/chat",
      body: "json",
      response: "ndjson",
      query: ["error", "truncated"],
      description: "Streams.",
    },
    {
      name: "put",
      method: "PUT",
      path: "/api/echo",
      body: "json",
      description: "Replace.",
    },
  ],
  tools: {
    "echo get": {
      title: "Echo",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          q: { type: "string" },
          flag: { type: "boolean" },
          path: { type: "array", items: { type: "string" } },
        },
        required: ["id"],
      },
    },
    "echo post": {
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          count: { type: "integer" },
          kind: { type: "string", enum: ["a", "b"] },
          nested: { type: "object", properties: { deep: { type: "number" } } },
          list: { type: "array", items: { type: ["string", "object"] } },
          renamed: { type: "string" },
        },
        required: ["title"],
      },
      rename: { renamed: "slug" },
    },
    "echo optional": {
      inputSchema: { type: "object", properties: { note: { type: "string" } } },
    },
    upload: {
      inputSchema: {
        type: "object",
        properties: {
          files: { type: "array", items: { type: "string" } },
          project: { type: "string" },
        },
        required: ["files"],
      },
    },
    raw: {
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, file: { type: "string" } },
        required: ["path", "file"],
      },
    },
    png: {
      download: true,
      inputSchema: {
        type: "object",
        properties: { output: { type: "string" } },
      },
    },
    big: {
      download: true,
      inputSchema: {
        type: "object",
        properties: {
          output: { type: "string" },
          chunked: { type: "boolean" },
        },
      },
    },
    text: {
      download: true,
      inputSchema: {
        type: "object",
        properties: { output: { type: "string" } },
      },
    },
    blob: {
      download: true,
      inputSchema: {
        type: "object",
        properties: { output: { type: "string" } },
      },
    },
    error: {
      download: true,
      inputSchema: {
        type: "object",
        properties: { output: { type: "string" } },
      },
    },
    partial: {
      inputSchema: {
        type: "object",
        properties: { some: { type: "boolean" } },
      },
    },
    cell: {},
    slow: {
      inputSchema: { type: "object", properties: { ms: { type: "integer" } } },
    },
    empty: {},
    chat: {
      inputSchema: {
        type: "object",
        properties: {
          messages: { type: "array" },
          error: { type: "boolean" },
          truncated: { type: "boolean" },
        },
        required: ["messages"],
      },
    },
    put: {
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
      },
    },
  },
};

let files, api, apiUrl, host, base, client;
beforeAll(async () => {
  files = await fixture();
  api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const encoder = new TextEncoder();
      if (url.pathname === "/api/error")
        return Response.json(
          { error: "Conflict", sourceSha256: "source-hash" },
          { status: 409 },
        );
      if (url.pathname === "/api/partial")
        return Response.json({
          uploaded: url.searchParams.has("some") ? ["ok"] : [],
          rejected: [{ name: "bad", error: "bad file" }],
        });
      if (url.pathname === "/api/cell-error")
        return Response.json({ output: { kind: "error", error: "boom" } });
      if (url.pathname === "/api/empty")
        return new Response(null, { status: 204 });
      if (url.pathname === "/api/slow") {
        await Bun.sleep(Number(url.searchParams.get("ms") || 100));
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/png")
        return new Response(PNG, { headers: { "Content-Type": "image/png" } });
      if (url.pathname === "/api/big") {
        const bytes = new Uint8Array(256).fill(7);
        if (url.searchParams.has("chunked"))
          return new Response(
            new ReadableStream({
              async start(controller) {
                for (let i = 0; i < 256; i += 32) {
                  controller.enqueue(bytes.slice(i, i + 32));
                  await Bun.sleep(1);
                }
                controller.close();
              },
            }),
            { headers: { "Content-Type": "image/png" } },
          );
        return new Response(bytes, {
          headers: { "Content-Type": "image/png" },
        });
      }
      if (url.pathname === "/api/text")
        return new Response("WEBVTT\n\n00:00.000 --> 00:01.000\nhéllo 🌱\n", {
          headers: { "Content-Type": "text/vtt; charset=utf-8" },
        });
      if (url.pathname === "/api/blob")
        return new Response(new Uint8Array([0, 1, 255, 128, 10]), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      if (url.pathname === "/api/chat") {
        const text = url.searchParams.has("error")
          ? '{"delta":"partial"}\n{"error":"Model failed"}\n'
          : url.searchParams.has("truncated")
            ? '{"delta":"partial"}\n'
            : '{"delta":"héllo "}\n{"delta":"🌱"}\n{"done":true,"model":"fixture"}';
        const bytes = encoder.encode(text);
        return new Response(
          new ReadableStream({
            async start(controller) {
              for (let i = 0; i < bytes.length; i += 2) {
                controller.enqueue(bytes.slice(i, i + 2));
                await Bun.sleep(1);
              }
              controller.close();
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      if (req.headers.get("content-type")?.includes("multipart/form-data")) {
        const form = await req.formData();
        const fields = {};
        for (const [key, value] of form.entries())
          if (typeof value === "string") fields[key] = value;
        return Response.json({
          fields,
          files: await Promise.all(
            form.getAll("files").map(async (f) => ({
              name: f.name,
              bytes: [...new Uint8Array(await f.arrayBuffer())],
            })),
          ),
        });
      }
      return Response.json({
        method: req.method,
        path: url.pathname,
        query: [...url.searchParams],
        contentType: req.headers.get("content-type"),
        body: await req.text(),
      });
    },
  });
  apiUrl = `http://127.0.0.1:${api.port}`;
  const handlers = {
    "/mcp": createMcpHttpHandler(fixtureConfig, {
      baseUrl: apiUrl,
      inlineImageBytes: 128,
    }),
    "/fast": createMcpHttpHandler(fixtureConfig, {
      baseUrl: apiUrl,
      timeoutMs: 50,
    }),
    "/dead": createMcpHttpHandler(fixtureConfig, {
      baseUrl: "http://127.0.0.1:1",
    }),
  };
  host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const handler = handlers[new URL(req.url).pathname];
      return handler ? handler(req) : new Response("nope", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${host.port}`;
  client = connect(base);
});
afterAll(async () => {
  host?.stop(true);
  api?.stop(true);
  await files?.cleanup();
});

test("compiling tools refuses gaps between commands and schemas", () => {
  const tools = compileTools(fixtureConfig);
  expect(tools.map((t) => t.name)).toContain("fixture_echo_get");
  expect(() =>
    compileTools({
      app: "x",
      commands: [{ name: "a", method: "GET", path: "/api/a" }],
      tools: {},
    }),
  ).toThrow(/No MCP tool describes/);
  expect(() =>
    compileTools({ app: "x", commands: [], tools: { ghost: {} } }),
  ).toThrow(/describes no command/);
  expect(() =>
    compileTools({
      app: "x",
      commands: [{ name: "a", method: "GET", path: "/api/a/:id" }],
      tools: {
        a: {
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      },
    }),
  ).toThrow(/required path parameter/);
  expect(() =>
    compileTools({
      app: "x",
      commands: [{ name: "a", method: "GET", path: "/api/a", query: ["q"] }],
      tools: { a: {} },
    }),
  ).toThrow(/undeclared argument/);
  expect(() =>
    compileTools({
      app: "x",
      commands: [
        { name: "a b", method: "GET", path: "/api/a" },
        { name: "a_b", method: "GET", path: "/api/b" },
      ],
      tools: { "a b": {}, a_b: {} },
    }),
  ).toThrow(/duplicate/);
});

test("this app's tools compile, are unique, and cover every CLI command", async () => {
  const tools = compileTools(appConfig);
  expect(tools.length).toBe(appConfig.commands.length);
  expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  for (const tool of tools) {
    expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(tool.name.startsWith(`${appConfig.app}_`)).toBe(true);
    expect(tool.description.length).toBeGreaterThan(10);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.additionalProperties).toBe(false);
    for (const [key, property] of Object.entries(tool.inputSchema.properties))
      expect(property.type, `${tool.name}.${key}`).toBeTruthy();
    expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
  }
  const source = await readFile(join(repo, "server.js"), "utf8");
  const routes = [];
  for (const match of source.matchAll(
    /"(\/api\/[^"*]+)": \{([\s\S]*?)(?=\n    "\/api\/|\n    "\/mcp"|\n  \},)/g,
  ))
    for (const method of match[2].matchAll(
      /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):/g,
    ))
      routes.push(`${method[1]} ${match[1]}`);
  expect(routes.length).toBeGreaterThan(0);
  expect(
    tools.map((t) => `${t.command.method} ${t.command.path}`).sort(),
  ).toEqual(routes.sort());
  expect(source).toContain('"/mcp": mcp');
});

test("argument validation catches the mistakes a model makes", () => {
  const schema = compileTools(fixtureConfig).find(
    (t) => t.name === "fixture_echo_post",
  ).inputSchema;
  expect(validateArguments(schema, { title: "x" })).toBeNull();
  expect(validateArguments(schema, {})).toMatch(/title is required/);
  expect(validateArguments(schema, { title: 1 })).toMatch(/must be string/);
  expect(validateArguments(schema, { title: "x", count: 1.5 })).toMatch(
    /must be integer/,
  );
  expect(validateArguments(schema, { title: "x", kind: "c" })).toMatch(
    /one of "a", "b"/,
  );
  expect(
    validateArguments(schema, { title: "x", nested: { deep: "no" } }),
  ).toMatch(/nested.deep must be number/);
  expect(
    validateArguments(schema, { title: "x", list: ["a", { any: 1 }, 2] }),
  ).toMatch(/list\[2\]/);
  expect(validateArguments(schema, { title: "x", typo: 1 })).toMatch(
    /typo is not an argument/,
  );
  expect(
    validateArguments(schema, { title: "x", count: 2, nested: { deep: 1 } }),
  ).toBeNull();
});

test("initialize negotiates a version and describes the server", async () => {
  const latest = await client.initialize("2025-06-18");
  expect(latest.protocolVersion).toBe("2025-06-18");
  expect(latest.serverInfo).toMatchObject({ name: "fixture" });
  expect(latest.capabilities.tools).toBeDefined();
  expect(latest.instructions).toBe("Fixture instructions.");
  expect((await client.initialize("2025-03-26")).protocolVersion).toBe(
    "2025-03-26",
  );
  expect((await client.initialize("1999-01-01")).protocolVersion).toBe(
    LATEST_PROTOCOL_VERSION,
  );
  expect(await client.call("ping")).toEqual({});
});

test("transport rules: methods, origins, protocol header, parse errors, batches", async () => {
  const url = client.url;
  expect((await fetch(url)).status).toBe(405);
  expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  expect(
    (await post(url, ping, { Origin: "https://evil.example" })).status,
  ).toBe(403);
  expect(
    (await post(url, ping, { Origin: "http://localhost:5173" })).status,
  ).toBe(200);
  expect(
    (await post(url, ping, { Origin: `http://127.0.0.1:${host.port}` })).status,
  ).toBe(200);
  expect(
    (await post(url, ping, { "MCP-Protocol-Version": "1999-01-01" })).status,
  ).toBe(400);
  for (const version of PROTOCOL_VERSIONS)
    expect(
      (await post(url, ping, { "MCP-Protocol-Version": version })).status,
    ).toBe(200);
  const parse = await post(url, "{not json");
  expect(parse.status).toBe(400);
  expect(parse.value.error.code).toBe(-32700);
  const invalid = await post(url, { id: 1, method: "ping" });
  expect(invalid.value.error.code).toBe(-32600);
  const unknown = await post(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "resources/list",
  });
  expect(unknown.value.error.code).toBe(-32601);
  const batch = await post(url, [
    { jsonrpc: "2.0", id: "a", method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: "b", method: "tools/list" },
  ]);
  expect(batch.status).toBe(200);
  expect(batch.value.map((m) => m.id)).toEqual(["a", "b"]);
  expect((await post(url, [])).status).toBe(400);
  expect(
    (
      await post(url, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: {},
      })
    ).status,
  ).toBe(202);
});

test("tools/list carries schemas, titles and method-derived annotations", async () => {
  const tools = await client.tools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  expect(byName.fixture_echo_get).toMatchObject({
    title: "Echo",
    annotations: { title: "Echo", readOnlyHint: true, destructiveHint: false },
  });
  expect(byName.fixture_echo_get.inputSchema.required).toEqual(["id"]);
  expect(byName.fixture_empty.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  expect(byName.fixture_put.annotations).toMatchObject({
    idempotentHint: true,
    destructiveHint: false,
  });
  expect(byName.fixture_echo_post.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
  });
  for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
});

test("tools/call rejects unknown tools and bad arguments before any request", async () => {
  const unknown = await client.request("tools/call", {
    name: "fixture_missing",
    arguments: {},
  });
  expect(unknown.error).toMatchObject({ code: -32602 });
  expect(unknown.error.message).toContain("Unknown tool");
  for (const args of [
    {},
    { id: 1 },
    { id: "x", flag: "yes" },
    { id: "x", typo: 1 },
    { id: "x", path: "a" },
  ]) {
    const response = await client.request("tools/call", {
      name: "fixture_echo_get",
      arguments: args,
    });
    expect(response.error?.code, JSON.stringify(args)).toBe(-32602);
  }
  expect(
    (
      await client.request("tools/call", {
        name: "fixture_echo_get",
        arguments: [],
      })
    ).error.code,
  ).toBe(-32602);
  expect((await client.request("tools/call", {})).error.code).toBe(-32602);
});

test("path parameters and query values are encoded, booleans become 1, arrays repeat", async () => {
  const result = await client.tool("fixture_echo_get", {
    id: "A & B/雪",
    q: "x=y&z",
    flag: true,
    path: ["first", "sec ond"],
  });
  expect(result).toMatchObject({
    method: "GET",
    path: "/api/echo/A%20%26%20B%2F%E9%9B%AA",
  });
  expect(result.query).toEqual([
    ["q", "x=y&z"],
    ["flag", "1"],
    ["path", "first"],
    ["path", "sec ond"],
  ]);
  const off = await client.tool("fixture_echo_get", { id: "x", flag: false });
  expect(off.query).toEqual([]);
  expect(
    (
      await client.request("tools/call", {
        name: "fixture_echo_get",
        arguments: { id: ".." },
      })
    ).error.code,
  ).toBe(-32602);
});

test("JSON bodies carry the remaining arguments with their types, renamed where declared", async () => {
  const result = await client.tool("fixture_echo_post", {
    title: "quotes ' & unicode 🌱",
    count: 3,
    nested: { deep: 1.5 },
    list: ["a", { b: [false, null] }],
    renamed: "slug-value",
  });
  expect(result.contentType).toContain("application/json");
  expect(JSON.parse(result.body)).toEqual({
    title: "quotes ' & unicode 🌱",
    count: 3,
    nested: { deep: 1.5 },
    list: ["a", { b: [false, null] }],
    slug: "slug-value",
  });
  expect(JSON.parse((await client.tool("fixture_echo_optional")).body)).toEqual(
    {},
  );
  expect((await client.tool("fixture_put", { title: "t" })).method).toBe("PUT");
});

test("multipart uploads read local files and send other arguments as fields", async () => {
  const path = join(files.dir, "up load.bin");
  await writeFile(path, new Uint8Array([0, 255, 42]));
  const result = await client.tool("fixture_upload", {
    files: [path, path],
    project: "A & B",
  });
  expect(result.fields).toEqual({ project: "A & B" });
  expect(result.files).toEqual([
    { name: "up load.bin", bytes: [0, 255, 42] },
    { name: "up load.bin", bytes: [0, 255, 42] },
  ]);
  const missing = await client.request("tools/call", {
    name: "fixture_upload",
    arguments: { files: [join(files.dir, "nope.bin")] },
  });
  expect(missing.error.code).toBe(-32602);
  expect(
    (
      await client.request("tools/call", {
        name: "fixture_upload",
        arguments: { files: [] },
      })
    ).error.code,
  ).toBe(-32602);
});

test("raw uploads send a local file's bytes as the body", async () => {
  const path = join(files.dir, "raw.txt");
  await writeFile(path, "hello\n雪");
  const result = await client.tool("fixture_raw", {
    path: "target.mp4",
    file: path,
  });
  expect(result.body).toBe("hello\n雪");
  expect(result.query).toEqual([["path", "target.mp4"]]);
});

test("API errors and failed operations are tool errors with the payload kept", async () => {
  const error = await client.tool("fixture_error", {}, { expectError: true });
  expect(error).toMatchObject({
    error: "Conflict",
    status: 409,
    details: { sourceSha256: "source-hash" },
  });
  const partial = await client.tool(
    "fixture_partial",
    {},
    { expectError: true },
  );
  expect(partial.rejected).toHaveLength(1);
  const some = await client.tool("fixture_partial", { some: true });
  expect(some.uploaded).toEqual(["ok"]);
  const cell = await client.tool("fixture_cell", {}, { expectError: true });
  expect(cell.output.kind).toBe("error");
  const empty = await client.call("tools/call", {
    name: "fixture_empty",
    arguments: {},
  });
  expect(JSON.parse(empty.content[0].text)).toMatchObject({
    ok: true,
    status: 204,
  });
  const dead = connect(base, "/dead");
  const unreachable = await dead.tool(
    "fixture_echo_optional",
    {},
    { expectError: true },
  );
  expect(unreachable.error).toContain(
    "No fixture server at http://127.0.0.1:1",
  );
});

test("downloads come back as images, text, links or files", async () => {
  const png = await client.call("tools/call", {
    name: "fixture_png",
    arguments: {},
  });
  expect(png.content[0]).toMatchObject({
    type: "image",
    mimeType: "image/png",
  });
  expect(Buffer.from(png.content[0].data, "base64")).toEqual(PNG);
  expect(png.structuredContent).toEqual({
    contentType: "image/png",
    size: PNG.length,
  });
  const text = await client.call("tools/call", {
    name: "fixture_text",
    arguments: {},
  });
  expect(text.content).toEqual([
    { type: "text", text: "WEBVTT\n\n00:00.000 --> 00:01.000\nhéllo 🌱\n" },
  ]);
  for (const args of [{}, { chunked: true }]) {
    const big = await client.call("tools/call", {
      name: "fixture_big",
      arguments: args,
    });
    expect(big.isError).toBeUndefined();
    expect(big.content[0]).toMatchObject({
      type: "resource_link",
      mimeType: "image/png",
    });
    expect(big.content[0].uri).toContain(`${apiUrl}/api/big`);
    expect(big.structuredContent.hint).toContain("output");
  }
  const blob = await client.call("tools/call", {
    name: "fixture_blob",
    arguments: {},
  });
  expect(blob.content[0]).toMatchObject({
    type: "resource_link",
    mimeType: "application/octet-stream",
  });
  const output = join(files.dir, "saved.bin");
  const saved = await client.tool("fixture_blob", { output });
  expect(saved).toEqual({
    saved: output,
    size: 5,
    contentType: "application/octet-stream",
  });
  expect([...(await readFile(output))]).toEqual([0, 1, 255, 128, 10]);
  const failed = await client.tool(
    "fixture_error",
    { output },
    { expectError: true },
  );
  expect(failed.status).toBe(409);
  expect([...(await readFile(output))]).toEqual([0, 1, 255, 128, 10]);
});

test("streamed chat replies are gathered, with progress over SSE when asked", async () => {
  const plain = await client.tool("fixture_chat", {
    messages: [{ role: "user", content: "hi" }],
  });
  expect(plain).toEqual({ reply: "héllo 🌱", model: "fixture" });
  const response = await fetch(client.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "fixture_chat",
        arguments: { messages: [] },
        _meta: { progressToken: "p1" },
      },
    }),
  });
  expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  const messages = sseMessages(await response.text());
  const progress = messages.filter(
    (m) => m.method === "notifications/progress",
  );
  expect(progress.map((m) => m.params.message)).toEqual(["héllo ", "🌱"]);
  expect(progress.every((m) => m.params.progressToken === "p1")).toBe(true);
  expect(messages.at(-1)).toMatchObject({
    id: 7,
    result: { content: [{ type: "text", text: "héllo 🌱" }] },
  });
  const failed = await client.tool(
    "fixture_chat",
    { messages: [], error: true },
    { expectError: true },
  );
  expect(failed).toEqual({ error: "Model failed", partial: "partial" });
  const truncated = await client.tool(
    "fixture_chat",
    { messages: [], truncated: true },
    { expectError: true },
  );
  expect(truncated.error).toContain("without a done event");
});

test("cancellation and timeouts end a call with an error instead of a hang", async () => {
  const started = Date.now();
  const slow = post(client.url, {
    jsonrpc: "2.0",
    id: "slow-call",
    method: "tools/call",
    params: { name: "fixture_slow", arguments: { ms: 3000 } },
  });
  await Bun.sleep(100);
  await post(client.url, {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: "slow-call", reason: "user changed their mind" },
  });
  const cancelled = await slow;
  expect(Date.now() - started).toBeLessThan(2500);
  expect(cancelled.value.result.isError).toBe(true);
  expect(cancelled.value.result.structuredContent.error).toContain(
    "changed their mind",
  );
  const fast = connect(base, "/fast");
  const timedOut = await fast.tool(
    "fixture_slow",
    { ms: 500 },
    { expectError: true },
  );
  expect(timedOut.error).toContain("Timed out");
});

test("stdio serves the same tools to a launched process and exits when stdin closes", async () => {
  const tools = compileTools(appConfig);
  const mcp = spawnMcp(["--base-url", apiUrl]);
  try {
    const init = await mcp.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    expect(init.serverInfo.name).toBe(appConfig.app);
    mcp.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await mcp.call("tools/list");
    expect(listed.tools.map((t) => t.name).sort()).toEqual(
      tools.map((t) => t.name).sort(),
    );
    const tool = readOnlyTool(listed.tools);
    expect(tool).toBeTruthy();
    const result = await mcp.call("tools/call", {
      name: tool.name,
      arguments: {},
    });
    expect(result.structuredContent.path).toBe(
      tools.find((t) => t.name === tool.name).command.path,
    );
    expect((await mcp.request("nope")).error.code).toBe(-32601);
    const { code, stderr } = await mcp.close();
    expect(code).toBe(0);
    expect(stderr).toBe("");
  } finally {
    mcp.proc.kill();
  }
}, 15000);

test("help lists every tool without a server; bad options exit 2", async () => {
  const help = Bun.spawnSync([join(repo, "mcp.js"), "--help"], { cwd: repo });
  expect(help.exitCode).toBe(0);
  for (const tool of compileTools(appConfig))
    expect(help.stdout.toString()).toContain(tool.name);
  const bad = Bun.spawnSync(
    [process.execPath, join(repo, "mcp.js"), "--typo"],
    { cwd: repo },
  );
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toContain("Unknown option");
  const both = Bun.spawnSync(
    [
      process.execPath,
      join(repo, "mcp.js"),
      "--start",
      "--base-url",
      "http://x",
    ],
    { cwd: repo },
  );
  expect(both.exitCode).toBe(2);
});
