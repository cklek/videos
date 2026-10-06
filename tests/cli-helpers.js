import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "bun:test";

export const repo = resolve(import.meta.dir, "..");
export const jsonArgs = (body) => ["--json", JSON.stringify(body)];
export async function cli(
  args,
  { baseUrl, stdin, env = {}, executable = false } = {},
) {
  const proc = Bun.spawn(
    [
      ...(executable
        ? [join(repo, "cli.js")]
        : [process.execPath, join(repo, "cli.js")]),
      ...args,
      ...(baseUrl ? ["--base-url", baseUrl] : []),
    ],
    {
      cwd: repo,
      env: { ...process.env, ...env },
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (stdin !== undefined) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [bytes, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const stdout = new TextDecoder().decode(bytes);
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {}
  return { code, bytes: new Uint8Array(bytes), stdout, stderr, value };
}

export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "app-cli-test-"));
  return {
    dir,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function startApp(dir, extraEnv = {}, workingDir = repo) {
  const proc = Bun.spawn([process.execPath, "server.js"], {
    cwd: workingDir,
    env: {
      ...process.env,
      HEADLESS: "1",
      HOST: "127.0.0.1",
      PORT: "0",
      NODE_ENV: "production",
      RSS_DATA_DIR: join(dir, "data"),
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
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  let timer, resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const stdout = (async () => {
    let text = "";
    try {
      for await (const chunk of proc.stdout) {
        text += new TextDecoder().decode(chunk);
        const port = text.match(/http:\/\/localhost:(\d+)/)?.[1];
        if (port) resolveReady(`http://127.0.0.1:${port}`);
      }
      rejectReady(new Error(`Server exited during startup: ${await stderr}`));
    } catch (error) {
      rejectReady(error);
    }
  })();
  try {
    const baseUrl = await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Server startup timed out")),
          15000,
        );
      }),
    ]);
    return {
      baseUrl,
      async stop() {
        proc.kill();
        await proc.exited;
        await stdout;
        await stderr;
      },
    };
  } catch (error) {
    proc.kill();
    await proc.exited;
    await stdout;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function runner(baseUrl) {
  const seen = new Set();
  return {
    seen,
    async run(name, args = [], options = {}) {
      const result = await cli([...name.split(" "), ...args], {
        baseUrl,
        ...options,
      });
      expect(result.stderr, `${name}: stderr`).toBe("");
      expect(result.code, `${name}: exit`).toBe(0);
      seen.add(name);
      return result.value === undefined ? result : result.value;
    },
  };
}
