import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import config from "../src/cli/commands.js";
import { cli, fixture, repo } from "./cli-helpers.js";

let files, server, baseUrl;
beforeAll(async () => {
  files = await fixture();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/error")
        return Response.json(
          { error: "Conflict", sourceSha256: "source-hash" },
          { status: 409 },
        );
      if (url.pathname === "/api/bytes")
        return new Response(new Uint8Array([0, 1, 255, 128, 10]), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      if (url.pathname === "/api/empty")
        return new Response(null, { status: 204 });
      if (url.pathname === "/api/slow") {
        await Bun.sleep(100);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/partial")
        return Response.json({
          uploaded: ["ok"],
          rejected: [{ error: "bad file" }],
        });
      if (url.pathname === "/api/events") {
        const encoder = new TextEncoder();
        const text = url.searchParams.has("error")
          ? '{"delta":"partial"}\n{"error":"Model failed"}\n'
          : url.searchParams.has("truncated")
            ? '{"delta":"partial"}\n'
            : '{"delta":"héllo 🌱"}\n{"done":true,"model":"fixture"}';
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
        return Response.json({
          fields: form.getAll("project"),
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
        header: req.headers.get("x-test"),
        body: await req.text(),
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  server?.stop(true);
  await files?.cleanup();
});

test("executable help works without a server and lists every command", async () => {
  const result = await cli(["--help"], { executable: true });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  for (const c of config.commands) expect(result.stdout).toContain(c.name);
});

test("every concrete server method and route has exactly one named command", async () => {
  const source = await readFile(join(repo, "server.js"), "utf8");
  const routes = [];
  for (const match of source.matchAll(
    /"(\/api\/[^"*]+)": \{([\s\S]*?)(?=\n    "\/api\/|\n  \},)/g,
  ))
    for (const method of match[2].matchAll(
      /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS):/g,
    ))
      routes.push(`${method[1]} ${match[1]}`);
  expect(routes.length).toBeGreaterThan(0);
  expect(config.commands.map((c) => `${c.method} ${c.path}`).sort()).toEqual(
    routes.sort(),
  );
  expect(new Set(config.commands.map((c) => c.name)).size).toBe(
    config.commands.length,
  );
});

test("JSON body supports inline, file and piped stdin", async () => {
  const source = JSON.stringify({
    title: "quotes ' & unicode 🌱",
    nested: [false, 0, "a\nb"],
  });
  const path = join(files.dir, "body.json");
  await writeFile(path, source);
  for (const [value, stdin] of [
    [source, undefined],
    [`@${path}`, undefined],
    ["-", source],
  ]) {
    const result = await cli(
      ["request", "POST", "/api/echo", "--json", value],
      { baseUrl, stdin },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.value.body)).toEqual(JSON.parse(source));
  }
});

test("query encoding, repeats, headers, URL environment and explicit override", async () => {
  const env = { [`${config.app.toUpperCase()}_API_URL`]: baseUrl };
  const result = await cli(
    [
      "request",
      "GET",
      "/api/echo",
      "--query",
      "path=A & B/雪",
      "--query",
      "path=second",
      "--header",
      "X-Test:hello",
    ],
    { env },
  );
  expect(result.code).toBe(0);
  expect(result.value.query).toEqual([
    ["path", "A & B/雪"],
    ["path", "second"],
  ]);
  expect(result.value.header).toBe("hello");
  expect(
    (
      await cli(["request", "GET", "/api/echo"], {
        baseUrl,
        env: { [`${config.app.toUpperCase()}_API_URL`]: "http://127.0.0.1:1" },
      })
    ).code,
  ).toBe(0);
});

test("multipart sends repeated files and fields without changing bytes", async () => {
  const path = join(files.dir, "upload.bin");
  await writeFile(path, new Uint8Array([0, 255, 42]));
  const result = await cli(
    [
      "request",
      "POST",
      "/api/upload",
      "--upload",
      path,
      "--upload",
      path,
      "--field",
      "project=A & B",
    ],
    { baseUrl },
  );
  expect(result.code).toBe(0);
  expect(result.value.fields).toEqual(["A & B"]);
  expect(result.value.files).toEqual([
    { name: "upload.bin", bytes: [0, 255, 42] },
    { name: "upload.bin", bytes: [0, 255, 42] },
  ]);
});

test("raw file and raw stdin uploads preserve bytes", async () => {
  const path = join(files.dir, "raw.txt");
  await writeFile(path, "hello\n雪");
  for (const [value, stdin] of [
    [path, undefined],
    ["-", "hello\n雪"],
  ]) {
    const result = await cli(
      ["request", "POST", "/api/echo", "--file", value],
      { baseUrl, stdin },
    );
    expect(result.code).toBe(0);
    expect(result.value.body).toBe("hello\n雪");
  }
});

test("binary stdout and file downloads are exact and failed downloads preserve files", async () => {
  const result = await cli(["request", "GET", "/api/bytes"], { baseUrl });
  expect(result.code).toBe(0);
  expect([...result.bytes]).toEqual([0, 1, 255, 128, 10]);
  const output = join(files.dir, "out.bin");
  expect(
    (
      await cli(["request", "GET", "/api/bytes", "--output", output], {
        baseUrl,
      })
    ).stdout,
  ).toBe("");
  expect([...(await readFile(output))]).toEqual([0, 1, 255, 128, 10]);
  const failure = await cli(
    ["request", "GET", "/api/error", "--output", output],
    { baseUrl },
  );
  expect(failure.code).toBe(1);
  expect(failure.stdout).toBe("");
  expect(JSON.parse(failure.stderr)).toMatchObject({
    status: 409,
    details: { sourceSha256: "source-hash" },
  });
  expect([...(await readFile(output))]).toEqual([0, 1, 255, 128, 10]);
});

test("Chat streams split Unicode and final unterminated lines as NDJSON or text", async () => {
  const ndjson = await cli(["request", "GET", "/api/events"], { baseUrl });
  expect(ndjson.code).toBe(0);
  expect(ndjson.stdout.trim().split("\n").map(JSON.parse)).toEqual([
    { delta: "héllo 🌱" },
    { done: true, model: "fixture" },
  ]);
  const text = await cli(["request", "GET", "/api/events", "--text"], {
    baseUrl,
  });
  expect(text.code).toBe(0);
  expect(text.stdout).toBe("héllo 🌱");
});

test("Chat errors and missing terminal events fail and preserve file destinations", async () => {
  const output = join(files.dir, "chat.txt");
  await writeFile(output, "old");
  for (const suffix of ["?error=1", "?truncated=1"]) {
    const result = await cli(
      ["request", "GET", `/api/events${suffix}`, "--output", output],
      { baseUrl },
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error).toBeTruthy();
    expect(await readFile(output, "utf8")).toBe("old");
  }
});

test("partial operation failure, timeout, connection failure, and empty response", async () => {
  const partial = await cli(["request", "GET", "/api/partial"], { baseUrl });
  expect(partial.code).toBe(1);
  expect(partial.value.rejected).toHaveLength(1);
  expect(
    (
      await cli(["request", "GET", "/api/slow", "--timeout", "0.01"], {
        baseUrl,
      })
    ).code,
  ).toBe(1);
  expect(
    (
      await cli(["request", "GET", "/api/echo"], {
        baseUrl: "http://127.0.0.1:1",
      })
    ).code,
  ).toBe(1);
  const empty = await cli(["request", "DELETE", "/api/empty"], { baseUrl });
  expect(empty.code).toBe(0);
  expect(empty.stdout).toBe("");
});

test("invalid usage fails before sending a request", async () => {
  for (const args of [
    ["missing-command"],
    ["request", "POST", "/api/echo", "--json", "{"],
    ["request", "POST", "/api/echo", "--json", "{}", "--file", "missing"],
    ["request", "GET", "/api/echo", "--query"],
    ["request", "GET", "/api/echo", "--typo", "x"],
    ["request", "GET", "/api/echo", "--timeout", "-1"],
    ["request", "GET", "/api/echo", "--json", "{}"],
    ["request", "GET", "https://example.com/api/echo"],
  ]) {
    const result = await cli(args, { baseUrl });
    expect(result.code, args.join(" ")).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toBeTruthy();
  }
});
