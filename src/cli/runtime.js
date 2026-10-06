import { createWriteStream } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";

class CliError extends Error {
  constructor(message, code = 2, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const valueOptions = [
  "base-url",
  "timeout",
  "header",
  "query",
  "json",
  "file",
  "upload",
  "field",
  "output",
];
const repeated = new Set(["header", "query", "upload", "field"]);

function parseArgs(args) {
  const words = [];
  const options = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help" || arg === "--text") {
      options.set(arg === "--text" ? "text" : "help", [true]);
    } else if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const key = arg.slice(2, equals < 0 ? undefined : equals);
      const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
      if (value === undefined || (equals < 0 && value.startsWith("--")))
        throw new CliError(
          `--${key} requires a value (use --${key}=VALUE for values beginning with --).`,
        );
      options.set(key, [...(options.get(key) || []), value]);
    } else if (arg.startsWith("-")) {
      throw new CliError(`Unknown option ${arg}.`);
    } else words.push(arg);
  }
  return { words, options };
}

function help(config, command) {
  const commands = command ? [command] : config.commands;
  return `${config.app} headless API CLI

Usage: bun run cli <command> [options]
       bun run cli request METHOD /api/path [options]

${commands
  .map((c) => {
    const params = [...c.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map(
      (m) => `--${m[1]} VALUE`,
    );
    const query = (c.query || []).map((q) => `[--${q} VALUE]`);
    const body =
      c.body === "json"
        ? "--json JSON|@FILE|-"
        : c.body === "json?"
          ? "[--json JSON|@FILE|-]"
          : c.body === "multipart"
            ? "--upload FILE [--upload FILE ...] [--field KEY=VALUE]"
            : c.body === "bytes"
              ? "--file FILE|-"
              : "";
    return `  ${c.name} ${[...params, ...query, body].filter(Boolean).join(" ")}\n    ${c.method} ${c.path} — ${c.description}`;
  })
  .join("\n")}

Options (may appear before or after the command):
  --base-url URL   App server origin; default $${config.app.toUpperCase()}_API_URL
                   or http://localhost:3000 (include a proxy prefix if needed).
  --timeout SEC    Whole-request timeout, default 300; 0 disables it.
  --header K:V     Additional HTTP header; repeatable (e.g. Range:bytes=0-99).
  --query K=V      Additional query parameter; repeatable, including the same key.
  --json VALUE    JSON body, @file, or - to read JSON from stdin.
  --file FILE     Raw request bytes from a file or - for stdin.
  --upload FILE   Multipart file, repeatable; sent in the files field.
  --field K=V     Multipart text field, repeatable.
  --output FILE  Write the response to a file; - means stdout (the default).
  --text         Chat: stream only text deltas instead of NDJSON events.
  --help, -h     Show help; append to a command for its route and arguments.

JSON responses go to stdout; binary/text responses are copied unchanged.
Chat emits NDJSON as events arrive. Errors go to stderr as JSON.
Exit codes: 0 success, 1 API/network/stream/operation failure, 2 usage error.
Start an API-only server separately with bun run headless; no browser is needed.
`;
}

function pair(value, separator, label) {
  const index = value.indexOf(separator);
  if (index <= 0) throw new CliError(`${label} requires KEY${separator}VALUE.`);
  return [value.slice(0, index), value.slice(index + 1)];
}

async function inputFile(value) {
  if (value === "-") return Bun.stdin;
  if (!(await stat(value)).isFile()) throw new CliError(`Not a file: ${value}`);
  return Bun.file(value);
}

async function makeRequest(config, args) {
  const { words, options } = parseArgs(args);
  const one = (key) => options.get(key)?.[0];
  const raw = words[0] === "request";
  let command = config.commands.find((c) => c.name === words.join(" "));
  if (one("help") || !words.length) {
    if (words.length && !raw && !command)
      throw new CliError(`Unknown command: ${words.join(" ")}`);
    return { help: help(config, command) };
  }
  if (raw) {
    if (
      words.length !== 3 ||
      !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(words[1])
    )
      throw new CliError("Usage: request METHOD /api/path");
    if (!/^\/api(?:\/|\?|$)/.test(words[2]) || words[2].includes("#"))
      throw new CliError(
        "The request path must start with /api and contain no fragment.",
      );
    command = { method: words[1].toUpperCase(), path: words[2] };
  }
  if (!command)
    throw new CliError(`Unknown command: ${words.join(" ")}. Use --help.`);
  const params = raw
    ? []
    : [...command.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]);
  const allowed = new Set([
    ...valueOptions,
    "text",
    ...params,
    ...(command.query || []),
  ]);
  for (const [key, values] of options) {
    if (!allowed.has(key))
      throw new CliError(
        `Unknown option --${key}. Use --query KEY=VALUE for extra query parameters.`,
      );
    if (
      values.length > 1 &&
      !repeated.has(key) &&
      !(command.query || []).includes(key)
    )
      throw new CliError(`--${key} may only be supplied once.`);
  }
  let route = command.path;
  for (const param of params) {
    if (!one(param) || one(param) === "." || one(param) === "..")
      throw new CliError(`--${param} is required and must name a resource.`);
    route = route.replace(`:${param}`, encodeURIComponent(one(param)));
  }
  let base;
  try {
    base = new URL(
      one("base-url") ||
        process.env[`${config.app.toUpperCase()}_API_URL`] ||
        "http://localhost:3000",
    );
  } catch {
    throw new CliError("--base-url must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(base.protocol) || base.search || base.hash)
    throw new CliError(
      "--base-url must be an HTTP(S) URL without a query or fragment.",
    );
  const url = new URL(base.href.replace(/\/$/, "") + route);
  for (const key of command.query || [])
    for (const value of options.get(key) || [])
      url.searchParams.append(key, value);
  for (const value of options.get("query") || [])
    url.searchParams.append(...pair(value, "=", "--query"));
  const headers = new Headers();
  for (const value of options.get("header") || [])
    headers.append(...pair(value, ":", "--header"));
  const hasJson = options.has("json"),
    hasFile = options.has("file");
  const hasForm = options.has("upload") || options.has("field");
  if (Number(hasJson) + Number(hasFile) + Number(hasForm) > 1)
    throw new CliError(
      "Use only one body format: --json, --file, or --upload/--field.",
    );
  if (!raw) {
    if (command.body === "json" && !hasJson)
      throw new CliError("This command requires --json JSON|@FILE|-.");
    if (command.body === "bytes" && !hasFile)
      throw new CliError("This command requires --file FILE|-.");
    if (command.body === "multipart" && !options.has("upload"))
      throw new CliError("This command requires at least one --upload FILE.");
    if (
      (hasJson && !command.body?.startsWith("json")) ||
      (hasFile && command.body !== "bytes") ||
      (hasForm && command.body !== "multipart")
    )
      throw new CliError(
        "This body format is not supported by the command. Use its --help.",
      );
    if (one("text") && command.response !== "ndjson")
      throw new CliError("--text is only available for Chat streaming.");
  }
  if (
    (hasJson || hasFile || hasForm) &&
    ["GET", "HEAD"].includes(command.method)
  )
    throw new CliError(`${command.method} requests cannot have a body.`);
  let body;
  if (hasJson) {
    const value = one("json");
    const source =
      value === "-"
        ? await Bun.stdin.text()
        : value.startsWith("@")
          ? await readFile(value.slice(1), "utf8")
          : value;
    try {
      body = JSON.stringify(JSON.parse(source));
    } catch {
      throw new CliError("Invalid JSON input.");
    }
    if (!headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
  } else if (hasFile) {
    body = await inputFile(one("file"));
  } else if (hasForm) {
    if (headers.has("Content-Type"))
      throw new CliError(
        "Multipart Content-Type is set automatically; omit that header.",
      );
    body = new FormData();
    for (const value of options.get("field") || [])
      body.append(...pair(value, "=", "--field"));
    for (const value of options.get("upload") || []) {
      if (value === "-")
        throw new CliError(
          "--upload requires a filename; use --file - for raw stdin.",
        );
      body.append("files", await inputFile(value), basename(value));
    }
  } else if (command.body === "json?") {
    body = "{}";
    if (!headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");
  }
  const timeout = Number(one("timeout") ?? 300);
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2147483)
    throw new CliError("--timeout must be between 0 and 2147483 seconds.");
  return {
    url,
    method: command.method,
    headers,
    body,
    timeout,
    output: one("output"),
    text: one("text"),
  };
}

async function* chatChunks(response, textOnly) {
  const decoder = new TextDecoder();
  let buffer = "",
    complete = false;
  function event(line) {
    if (!line.trim()) return "";
    const value = JSON.parse(line);
    if (value.error) throw new CliError(value.error, 1, value);
    if (value.done) complete = true;
    return textOnly ? value.delta || "" : JSON.stringify(value) + "\n";
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      yield event(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield event(buffer);
  if (!complete)
    throw new CliError("Chat stream ended without a done event.", 1);
}

async function writeOutput(source, output) {
  const input = Readable.from(source);
  if (!output || output === "-") {
    await pipeline(input, process.stdout, { end: false });
    return;
  }
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await pipeline(input, createWriteStream(temporary, { flags: "wx" }));
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runCli(config, args = process.argv.slice(2)) {
  let timer, interrupted;
  const controller = new AbortController();
  const interrupt = (signal) => {
    interrupted = signal;
    controller.abort();
  };
  const sigint = () => interrupt("SIGINT"),
    sigterm = () => interrupt("SIGTERM");
  try {
    const request = await makeRequest(config, args);
    if (request.help) {
      process.stdout.write(request.help);
      return;
    }
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
    if (request.timeout)
      timer = setTimeout(
        () => controller.abort(new Error("Request timed out.")),
        request.timeout * 1000,
      );
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      const raw = await response.text();
      let details;
      try {
        details = JSON.parse(raw);
      } catch {
        details = { body: raw };
      }
      const error = new CliError(
        details?.error || `HTTP ${response.status}`,
        1,
        details,
      );
      error.status = response.status;
      throw error;
    }
    const type = response.headers.get("Content-Type") || "";
    if (type.includes("application/x-ndjson")) {
      await writeOutput(chatChunks(response, request.text), request.output);
    } else if (request.text) {
      throw new CliError("--text requires an NDJSON Chat response.", 1);
    } else if (
      type.includes("application/json") &&
      request.method !== "HEAD" &&
      response.status !== 204
    ) {
      const payload = await response.json();
      await writeOutput(
        [JSON.stringify(payload, null, 2) + "\n"],
        request.output,
      );
      if (
        payload?.error ||
        payload?.output?.kind === "error" ||
        payload?.rejected?.length ||
        payload?.errors?.length
      )
        throw new CliError(
          payload.error ||
            payload.output?.error ||
            "The API reported failed operations; see the response.",
          1,
          payload,
        );
    } else {
      await writeOutput(response.body || [], request.output);
    }
  } catch (error) {
    if (error.code === "EPIPE") return;
    process.exitCode = interrupted
      ? interrupted === "SIGINT"
        ? 130
        : 143
      : error instanceof CliError
        ? error.code
        : 1;
    process.stderr.write(
      JSON.stringify({
        error: interrupted ? `Interrupted by ${interrupted}.` : error.message,
        ...(error.status ? { status: error.status } : {}),
        ...(error.details !== undefined ? { details: error.details } : {}),
      }) + "\n",
    );
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigterm);
  }
}
