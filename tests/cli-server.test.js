import { expect, test } from "bun:test";
import { cp, mkdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fixture, repo, startApp } from "./cli-helpers.js";

test("API-only server starts with no HTML, React app, styles, or fonts present", async () => {
  const files = await fixture();
  let app;
  try {
    const backend = join(files.dir, "backend");
    await mkdir(join(backend, "src"), { recursive: true });
    for (const entry of [
      "server.js",
      "package.json",
      "src/server",
      "src/lib",
      "src/cli",
      "src/mcp",
    ])
      if (await stat(join(repo, entry)).catch(() => null))
        await cp(join(repo, entry), join(backend, entry), { recursive: true });
    await symlink(
      join(repo, "node_modules"),
      join(backend, "node_modules"),
      "dir",
    );
    expect(
      await stat(join(backend, "index.html")).catch(() => null),
    ).toBeNull();
    app = await startApp(files.dir, {}, backend);
    const response = await fetch(app.baseUrl + "/");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect((await fetch(app.baseUrl + "/api/does-not-exist")).status).toBe(404);
  } finally {
    await app?.stop();
    await files.cleanup();
  }
}, 30000);

test("normal server still serves the web app and a compiled frontend script", async () => {
  const files = await fixture();
  let app;
  try {
    app = await startApp(files.dir, { HEADLESS: "0" });
    const response = await fetch(app.baseUrl + "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain('id="root"');
    const script = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].at(
      -1,
    )?.[1];
    expect(script).toBeTruthy();
    const bundle = await fetch(new URL(script, app.baseUrl));
    expect(bundle.status).toBe(200);
    expect((await bundle.text()).length).toBeGreaterThan(100);
  } finally {
    await app?.stop();
    await files.cleanup();
  }
}, 30000);
