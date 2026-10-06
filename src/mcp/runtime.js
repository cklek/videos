import { rename, rm, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0];
export const DEFAULT_INLINE_IMAGE_BYTES = 3 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export class McpError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function pathParams(path) {
  return [...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]);
}

export function toolNameFor(app, commandName) {
  return `${app}_${commandName}`.replace(/[^A-Za-z0-9_]+/g, "_");
}

function defaultAnnotations(method) {
  if (method === "GET" || method === "HEAD")
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  return {
    readOnlyHint: false,
    destructiveHint: method === "DELETE",
    idempotentHint: method === "PUT" || method === "DELETE",
    openWorldHint: false,
  };
}

export function compileTools(config) {
  const described = config.tools || {};
  const tools = [];
  const names = new Set();
  const covered = new Set();
  for (const command of config.commands) {
    const entry = described[command.name];
    if (!entry)
      throw new Error(`No MCP tool describes the "${command.name}" command.`);
    covered.add(command.name);
    const name = entry.name || toolNameFor(config.app, command.name);
    if (!TOOL_NAME.test(name) || names.has(name))
      throw new Error(`Invalid or duplicate MCP tool name: ${name}`);
    names.add(name);
    const params = pathParams(command.path);
    const schema = entry.inputSchema || { type: "object", properties: {} };
    const properties = schema.properties || {};
    for (const param of params)
      if (!properties[param] || !(schema.required || []).includes(param))
        throw new Error(
          `Tool ${name} must declare the required path parameter "${param}".`,
        );
    const query = isObject(entry.query)
      ? entry.query
      : Object.fromEntries((command.query || []).map((key) => [key, key]));
    for (const key of Object.keys(query))
      if (!properties[key])
        throw new Error(`Tool ${name} maps undeclared argument "${key}".`);
    for (const key of Object.keys(entry.rename || {}))
      if (!properties[key])
        throw new Error(`Tool ${name} renames undeclared argument "${key}".`);
    tools.push({
      name,
      title: entry.title,
      description: entry.description || command.description,
      inputSchema: {
        ...schema,
        type: "object",
        properties,
        additionalProperties: schema.additionalProperties ?? false,
      },
      annotations: {
        ...defaultAnnotations(command.method),
        ...(entry.annotations || {}),
      },
      command,
      params,
      query,
      rename: entry.rename || {},
      download: Boolean(entry.download),
    });
  }
  for (const commandName of Object.keys(described))
    if (!covered.has(commandName))
      throw new Error(`MCP tool "${commandName}" describes no command.`);
  return tools;
}

export function publicTool(tool) {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      ...(tool.title ? { title: tool.title } : {}),
      ...tool.annotations,
    },
  };
}

const typeOf = (value) =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : Number.isInteger(value)
        ? "integer"
        : typeof value;

function typeMatches(expected, value) {
  const actual = typeOf(value);
  return [expected]
    .flat()
    .some(
      (type) =>
        type === actual ||
        (type === "number" && actual === "integer") ||
        type === "any",
    );
}

export function validateArguments(schema, value, path = "arguments") {
  if (!schema || schema === true) return null;
  if (schema.type && !typeMatches(schema.type, value))
    return `${path} must be ${[schema.type].flat().join(" or ")}, got ${typeOf(value)}.`;
  if (schema.enum && !schema.enum.includes(value))
    return `${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}.`;
  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index++) {
      const error = validateArguments(
        schema.items,
        value[index],
        `${path}[${index}]`,
      );
      if (error) return error;
    }
  }
  if (isObject(value) && (schema.properties || schema.required)) {
    for (const key of schema.required || [])
      if (value[key] === undefined) return `${path}.${key} is required.`;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties === false)
          return `${path}.${key} is not an argument of this tool.`;
        if (isObject(schema.additionalProperties)) {
          const error = validateArguments(
            schema.additionalProperties,
            entry,
            `${path}.${key}`,
          );
          if (error) return error;
        }
        continue;
      }
      const error = validateArguments(property, entry, `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

function queryValues(value) {
  if (value === undefined || value === null || value === false) return [];
  if (value === true) return ["1"];
  if (Array.isArray(value)) return value.flatMap(queryValues);
  return [String(value)];
}

async function localFile(value) {
  if (typeof value !== "string" || !value)
    throw new McpError(INVALID_PARAMS, "A local file path is required.");
  const path = resolve(value);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile())
    throw new McpError(INVALID_PARAMS, `Not a readable file: ${value}`);
  return Bun.file(path);
}

export async function buildRequest(tool, args, baseUrl) {
  let route = tool.command.path;
  for (const param of tool.params) {
    const value = String(args[param]);
    if (!value || value === "." || value === "..")
      throw new McpError(INVALID_PARAMS, `${param} must name a resource.`);
    route = route.replace(`:${param}`, encodeURIComponent(value));
  }
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new McpError(INTERNAL_ERROR, `Invalid app server URL: ${baseUrl}`);
  }
  const url = new URL(base.href.replace(/\/$/, "") + route);
  const used = new Set(tool.params);
  for (const [arg, key] of Object.entries(tool.query)) {
    if (args[arg] === undefined) continue;
    used.add(arg);
    for (const value of queryValues(args[arg]))
      url.searchParams.append(key, value);
  }
  if (tool.download) used.add("output");
  const rest = {};
  for (const [key, value] of Object.entries(args))
    if (!used.has(key) && value !== undefined)
      rest[tool.rename[key] || key] = value;
  const headers = new Headers();
  let body;
  const kind = tool.command.body;
  if (kind === "json" || kind === "json?") {
    body = JSON.stringify(rest);
    headers.set("Content-Type", "application/json");
  } else if (kind === "multipart") {
    const { files, ...fields } = rest;
    if (!Array.isArray(files) || files.length === 0)
      throw new McpError(INVALID_PARAMS, "files must list at least one path.");
    body = new FormData();
    for (const [key, value] of Object.entries(fields))
      body.append(key, String(value));
    for (const file of files)
      body.append("files", await localFile(file), basename(String(file)));
  } else if (kind === "bytes") {
    const { file, ...extra } = rest;
    if (Object.keys(extra).length)
      throw new McpError(
        INVALID_PARAMS,
        `Unexpected argument ${Object.keys(extra)[0]} for a raw upload.`,
      );
    body = await localFile(file);
  } else if (Object.keys(rest).length) {
    throw new McpError(
      INVALID_PARAMS,
      `${tool.name} does not accept a body argument "${Object.keys(rest)[0]}".`,
    );
  }
  return { url, method: tool.command.method, headers, body };
}

const textContent = (text) => ({ type: "text", text });
const jsonText = (value) => JSON.stringify(value, null, 2);

export function operationFailure(payload) {
  return Boolean(
    payload?.error ||
      payload?.output?.kind === "error" ||
      (payload?.rejected?.length && !payload?.uploaded?.length),
  );
}

function errorResult(error, extra = {}) {
  const payload = { error, ...extra };
  return {
    content: [textContent(jsonText(payload))],
    structuredContent: payload,
    isError: true,
  };
}

async function* lines(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer;
}

async function collectNdjson(response, progress) {
  let text = "";
  let model;
  let done = false;
  for await (const line of lines(response.body)) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return errorResult("The stream sent a line that is not JSON.", {
        partial: text,
      });
    }
    if (value.error) return errorResult(value.error, { partial: text });
    if (value.delta) {
      text += value.delta;
      progress?.({ progress: text.length, message: value.delta });
    }
    if (value.done) {
      done = true;
      model = value.model;
    }
  }
  if (!done)
    return errorResult("Chat stream ended without a done event.", {
      partial: text,
    });
  return {
    content: [textContent(text)],
    structuredContent: { reply: text, ...(model ? { model } : {}) },
  };
}

async function saveResponse(response, output) {
  const target = resolve(output);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, response);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return { saved: target, size: (await stat(target)).size };
}

async function renderDownload(response, { url, output, inlineImageBytes }) {
  const contentType =
    response.headers.get("Content-Type") || "application/octet-stream";
  const mimeType =
    contentType.split(";")[0].trim() || "application/octet-stream";
  if (output) {
    const saved = await saveResponse(response, output);
    const payload = { ...saved, contentType: mimeType };
    return {
      content: [textContent(jsonText(payload))],
      structuredContent: payload,
    };
  }
  const isText =
    mimeType.startsWith("text/") ||
    mimeType === "image/svg+xml" ||
    mimeType.endsWith("+xml") ||
    mimeType.endsWith("+json") ||
    mimeType === "application/xml";
  const isImage = mimeType.startsWith("image/") && !isText;
  const limit = isImage ? inlineImageBytes : 1024 * 1024;
  const declared = Number(response.headers.get("Content-Length"));
  let bytes = null;
  if (!Number.isFinite(declared) || declared <= limit) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        break;
      }
      chunks.push(chunk);
    }
    if (tooLarge) await response.body.cancel().catch(() => {});
    else bytes = Buffer.concat(chunks);
  } else await response.body.cancel().catch(() => {});
  if (bytes && isText)
    return { content: [textContent(bytes.toString("utf8"))] };
  if (bytes && isImage) {
    const summary = { contentType: mimeType, size: bytes.length };
    return {
      content: [
        { type: "image", data: bytes.toString("base64"), mimeType },
        textContent(jsonText(summary)),
      ],
      structuredContent: summary,
    };
  }
  const summary = {
    url: url.href,
    contentType: mimeType,
    ...(Number.isFinite(declared) && declared > 0 ? { size: declared } : {}),
    hint: "Pass output to save the bytes to a file, or fetch the url from the API.",
  };
  return {
    content: [
      {
        type: "resource_link",
        uri: url.href,
        name: decodeURIComponent(
          url.searchParams.get("path") || basename(url.pathname),
        ),
        mimeType,
        description: `${mimeType}${summary.size ? `, ${summary.size} bytes` : ""}`,
      },
      textContent(jsonText(summary)),
    ],
    structuredContent: summary,
  };
}

async function renderResponse(tool, response, context) {
  const type = response.headers.get("Content-Type") || "";
  if (!response.ok) {
    const raw = await response.text();
    let details;
    try {
      details = JSON.parse(raw);
    } catch {
      details = { body: raw.slice(0, 4000) };
    }
    return errorResult(details?.error || `HTTP ${response.status}`, {
      status: response.status,
      details,
    });
  }
  if (type.includes("application/x-ndjson"))
    return collectNdjson(response, context.progress);
  if (
    type.includes("application/json") &&
    tool.command.method !== "HEAD" &&
    response.status !== 204
  ) {
    const payload = await response.json();
    return {
      content: [textContent(jsonText(payload))],
      ...(isObject(payload) ? { structuredContent: payload } : {}),
      ...(operationFailure(payload) ? { isError: true } : {}),
    };
  }
  if (response.status === 204 || tool.command.method === "HEAD")
    return {
      content: [textContent(jsonText({ ok: true, status: response.status }))],
    };
  return renderDownload(response, context);
}

export function createMcpServer(config, options = {}) {
  const tools = compileTools(config);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const inflight = new Map();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inlineImageBytes =
    options.inlineImageBytes ??
    Number(process.env.MCP_INLINE_IMAGE_BYTES || DEFAULT_INLINE_IMAGE_BYTES);
  const baseUrl = () =>
    typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl;
  const version = options.version || config.version || "0.1.0";

  async function callTool(params, context, id) {
    if (!isObject(params) || typeof params.name !== "string")
      throw new McpError(INVALID_PARAMS, "tools/call needs a tool name.");
    const tool = byName.get(params.name);
    if (!tool)
      throw new McpError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
    const args = params.arguments ?? {};
    if (!isObject(args))
      throw new McpError(INVALID_PARAMS, "arguments must be an object.");
    const invalid = validateArguments(tool.inputSchema, args);
    if (invalid) throw new McpError(INVALID_PARAMS, invalid);
    const request = await buildRequest(tool, args, baseUrl());
    const controller = new AbortController();
    if (id !== undefined && id !== null) inflight.set(id, controller);
    const timer = timeoutMs
      ? setTimeout(
          () => controller.abort(new Error(`Timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        )
      : null;
    const token = params._meta?.progressToken;
    const progress =
      token !== undefined && context.notify
        ? (update) =>
            context.notify({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: { progressToken: token, ...update },
            })
        : null;
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
        redirect: "error",
      });
      return await renderResponse(tool, response, {
        url: request.url,
        output: tool.download ? args.output : undefined,
        progress,
        inlineImageBytes,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        return errorResult(
          reason instanceof Error
            ? reason.message
            : "The request was cancelled.",
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      const unreachable =
        /ECONNREFUSED|Unable to connect|fetch failed|ConnectionRefused/i.test(
          message,
        );
      return errorResult(
        unreachable
          ? `No ${config.app} server at ${baseUrl()}. Start one with bun run headless (or bun run mcp --start).`
          : message,
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (id !== undefined && id !== null) inflight.delete(id);
    }
  }

  async function dispatch(message, context) {
    const { method, params, id } = message;
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: config.app,
            title: config.title || `${config.app} API`,
            version,
          },
          ...(config.instructions
            ? { instructions: config.instructions.trim() }
            : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: tools.map(publicTool) };
      case "tools/call":
        return callTool(params, context, id);
      case "notifications/initialized":
      case "notifications/progress":
      case "notifications/roots/list_changed":
        return undefined;
      case "notifications/cancelled": {
        const controller = inflight.get(params?.requestId);
        controller?.abort(
          new Error(params?.reason || "Cancelled by the client."),
        );
        return undefined;
      }
      default:
        throw new McpError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async function handle(message, context = {}) {
    if (!isObject(message) || message.jsonrpc !== "2.0")
      return rpcError(
        isObject(message) ? (message.id ?? null) : null,
        INVALID_REQUEST,
        "Invalid JSON-RPC 2.0 message.",
      );
    if (message.method === undefined) return undefined; // a response from the client
    const id = message.id;
    const isRequest = id !== undefined && id !== null;
    if (
      typeof message.method !== "string" ||
      (isRequest && !["string", "number"].includes(typeof id))
    )
      return rpcError(
        isRequest ? id : null,
        INVALID_REQUEST,
        "Invalid JSON-RPC 2.0 message.",
      );
    try {
      const result = await dispatch(message, context);
      if (!isRequest) return undefined;
      return { jsonrpc: "2.0", id, result: result ?? {} };
    } catch (error) {
      if (!isRequest) return undefined;
      if (error instanceof McpError)
        return rpcError(id, error.code, error.message, error.data);
      return rpcError(
        id,
        INTERNAL_ERROR,
        error instanceof Error ? error.message : "Internal error.",
      );
    }
  }

  return { tools, handle, baseUrl, app: config.app };
}

export function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

export function originAllowed(req) {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return !origin;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host) || host.endsWith(".localhost")) return true;
  const requestHost = (req.headers.get("host") || "").toLowerCase();
  return Boolean(requestHost) && parsed.host.toLowerCase() === requestHost;
}

function jsonResponse(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}

export function createMcpHttpHandler(config, options = {}) {
  const server = createMcpServer(config, options);
  const handler = async (req) => {
    if (req.method !== "POST")
      return jsonResponse(
        rpcError(null, INVALID_REQUEST, "MCP messages are sent with POST."),
        405,
        { Allow: "POST" },
      );
    if (!originAllowed(req))
      return jsonResponse(
        rpcError(null, INVALID_REQUEST, "Origin not allowed."),
        403,
      );
    const version = req.headers.get("mcp-protocol-version");
    if (version && !PROTOCOL_VERSIONS.includes(version))
      return jsonResponse(
        rpcError(
          null,
          INVALID_REQUEST,
          `Unsupported MCP-Protocol-Version: ${version}`,
        ),
        400,
      );
    let parsed;
    try {
      parsed = await req.json();
    } catch {
      return jsonResponse(rpcError(null, PARSE_ERROR, "Parse error."), 400);
    }
    const batch = Array.isArray(parsed);
    const messages = batch ? parsed : [parsed];
    if (batch && messages.length === 0)
      return jsonResponse(rpcError(null, INVALID_REQUEST, "Empty batch."), 400);
    const requests = messages.filter(
      (message) =>
        isObject(message) &&
        message.id !== undefined &&
        message.id !== null &&
        message.method !== undefined,
    );
    if (
      !requests.length &&
      messages.every((m) => isObject(m) && m.jsonrpc === "2.0")
    ) {
      for (const message of messages) server.handle(message).catch(() => {});
      return new Response(null, { status: 202 });
    }
    const accept = req.headers.get("accept") || "";
    const streaming =
      accept.includes("text/event-stream") &&
      messages.some(
        (message) => message?.params?._meta?.progressToken !== undefined,
      );
    if (!streaming) {
      const responses = (
        await Promise.all(messages.map((message) => server.handle(message)))
      ).filter(Boolean);
      return jsonResponse(batch ? responses : responses[0]);
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (message) => {
          try {
            controller.enqueue(
              encoder.encode(
                `event: message\ndata: ${JSON.stringify(message)}\n\n`,
              ),
            );
          } catch {}
        };
        await Promise.all(
          messages.map(async (message) => {
            const response = await server.handle(message, { notify: send });
            if (response) send(response);
          }),
        );
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      },
    });
  };
  handler.server = server;
  return handler;
}

export function loopbackUrl(server) {
  const hostname = server.hostname || "127.0.0.1";
  const host =
    hostname === "0.0.0.0" || hostname === "::" || hostname === "[::]"
      ? "127.0.0.1"
      : hostname.includes(":") && !hostname.startsWith("[")
        ? `[${hostname}]`
        : hostname;
  return `http://${host}:${server.port}`;
}

export function defaultBaseUrl(config, env = process.env) {
  return env[`${config.app.toUpperCase()}_API_URL`] || "http://localhost:3000";
}

function help(config) {
  const tools = compileTools(config)
    .map(
      (tool) =>
        `  ${tool.name.padEnd(34)} ${tool.command.method} ${tool.command.path}`,
    )
    .join("\n");
  return `${config.app} MCP server (stdio)

Usage: bun run mcp [--base-url URL | --start]

Speaks the Model Context Protocol on stdin/stdout for clients that launch a
server process. Every tool calls the app's HTTP API; MCP.md has the details.

Tools:
${tools}

  --base-url URL  App server origin; default $${config.app.toUpperCase()}_API_URL
                  or http://localhost:3000.
  --start         Start an API-only ${config.app} server on a free loopback port
                  for this session instead of connecting to a running one.
  --help, -h      Show this help.

The running web server also answers MCP requests at POST /mcp.
`;
}

async function startAppServer(config) {
  const root = resolve(import.meta.dir, "../..");
  const proc = Bun.spawn([process.execPath, "server.js"], {
    cwd: root,
    env: { ...process.env, HEADLESS: "1", HOST: "127.0.0.1", PORT: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let banner = "";
  const forward = async (stream, onText) => {
    for await (const chunk of stream) {
      const text = decoder.decode(chunk);
      onText?.(text);
      process.stderr.write(text);
    }
  };
  const pumps = [
    forward(proc.stdout, (text) => {
      banner += text;
      const port = banner.match(/http:\/\/localhost:(\d+)/)?.[1];
      if (port) resolveReady(`http://127.0.0.1:${port}`);
    }),
    forward(proc.stderr),
  ];
  proc.exited.then((code) =>
    rejectReady(
      new Error(
        `${config.app} server exited with code ${code} during startup.`,
      ),
    ),
  );
  let timer;
  try {
    const baseUrl = await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("The app server did not start in time.")),
          20000,
        );
      }),
    ]);
    return {
      baseUrl,
      async stop() {
        proc.kill();
        await proc.exited;
        await Promise.allSettled(pumps);
      },
    };
  } catch (error) {
    proc.kill();
    await proc.exited;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parseMcpArgs(args) {
  const options = { start: false, help: false, baseUrl: undefined };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--start") options.start = true;
    else if (arg === "--base-url" || arg.startsWith("--base-url=")) {
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : args[++i];
      if (!value) throw new Error("--base-url requires a value.");
      options.baseUrl = value;
    } else throw new Error(`Unknown option ${arg}.`);
  }
  if (options.start && options.baseUrl)
    throw new Error("--start and --base-url are mutually exclusive.");
  return options;
}

export async function runMcp(config, args = process.argv.slice(2)) {
  let options;
  try {
    options = parseMcpArgs(args);
  } catch (error) {
    process.stderr.write(`${error.message}\n${help(config)}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(help(config));
    return;
  }
  let app;
  let baseUrl = options.baseUrl || defaultBaseUrl(config);
  if (options.start) {
    try {
      app = await startAppServer(config);
      baseUrl = app.baseUrl;
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return;
    }
  }
  const server = createMcpServer(config, { baseUrl });
  const write = (message) => {
    process.stdout.write(JSON.stringify(message) + "\n");
  };
  const pending = new Set();
  const receive = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(rpcError(null, PARSE_ERROR, "Parse error."));
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    for (const entry of messages) {
      const task = server
        .handle(entry, { notify: write })
        .then((response) => response && write(response))
        .catch((error) =>
          write(rpcError(entry?.id ?? null, INTERNAL_ERROR, error.message)),
        )
        .finally(() => pending.delete(task));
      pending.add(task);
    }
  };
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled([...pending]);
    await app?.stop();
  };
  const onSignal = () => shutdown().then(() => process.exit(0));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of Bun.stdin.stream()) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) receive(line);
      }
    }
    if (buffer.trim()) receive(buffer.trim());
  } finally {
    await shutdown();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
