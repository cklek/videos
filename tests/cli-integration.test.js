import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import config from "../src/cli/commands.js";
import { cli, fixture, startApp, runner, jsonArgs } from "./cli-helpers.js";

function mediaFixture(app) {
  if (app === "photos")
    return {
      extension: "png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=",
        "base64",
      ),
    };
  if (app === "videos") {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(24, 0);
    bytes.write("ftypisom", 4);
    bytes.write("isommp42", 16);
    bytes.writeUInt32BE(8, 24);
    bytes.write("mdat", 28);
    return { extension: "mp4", bytes };
  }
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4, 40);
  return { extension: "wav", bytes };
}

test(`all ${config.app} CLI commands operate on isolated media, bytes and saved groups`, async () => {
  const files = await fixture();
  let app;
  const name = config.app;
  const item = { music: "track", videos: "video", photos: "photo" }[name];
  const group = { music: "playlist", videos: "collection", photos: "album" }[
    name
  ];
  const art = { music: "art", videos: "poster", photos: "thumb" }[name];
  try {
    app = await startApp(files.dir);
    expect((await fetch(app.baseUrl + "/")).status).toBe(404);
    const { run, seen } = runner(app.baseUrl);
    const media = mediaFixture(name),
      local = join(files.dir, `A & B.${media.extension}`);
    await writeFile(local, media.bytes);
    const upload = await run("upload", ["--upload", local]);
    expect(upload.uploaded).toHaveLength(1);
    const path = upload.uploaded[0];
    const library = await run("library list", ["--rescan", "1"]);
    expect(
      library[item === "track" ? "tracks" : name].some(
        (entry) => entry.path === path,
      ),
    ).toBe(true);
    expect((await run("rescan", ["--force", "1"])).count).toBe(1);
    const output = join(files.dir, "download.bin");
    await run("file get", ["--path", path, "--output", output]);
    expect(await readFile(output)).toEqual(media.bytes);
    const range = await cli(
      ["file", "get", "--path", path, "--header", "Range:bytes=0-7"],
      { baseUrl: app.baseUrl },
    );
    expect(range.code).toBe(0);
    expect(Buffer.from(range.bytes)).toEqual(media.bytes.subarray(0, 8));
    const preview = join(files.dir, "preview.bin");
    await run(`${art} get`, ["--path", path, "--output", preview]);
    expect((await readFile(preview)).length).toBeGreaterThan(0);
    expect(
      (await run(`${item} update`, jsonArgs({ path, title: "CLI title" })))
        .override.title,
    ).toBe("CLI title");
    await run("favorite set", jsonArgs({ path, favorite: true }));
    const created = await run(
      `${group}s create`,
      jsonArgs({ name: "CLI group", paths: [path] }),
    );
    const id = String(created[group].id);
    expect(
      (
        await run(`${group}s update`, [
          "--id",
          id,
          ...jsonArgs({ name: "Renamed", paths: [path] }),
        ])
      )[group].name,
    ).toBe("Renamed");
    const updated = await run("library list");
    expect(
      updated[item === "track" ? "tracks" : name].find(
        (entry) => entry.path === path,
      ),
    ).toMatchObject({ title: "CLI title", favorite: true });
    expect(
      updated[`${group}s`].find((entry) => String(entry.id) === id).name,
    ).toBe("Renamed");
    if (name === "videos") {
      const jpeg = join(files.dir, "poster.jpg");
      const jpegBytes = new Uint8Array([255, 216, 255, 217]);
      await writeFile(jpeg, jpegBytes);
      expect(
        (await run("poster save", ["--path", path, "--file", jpeg])).poster,
      ).toBe(true);
      await run("poster get", ["--path", path, "--output", preview]);
      expect([...(await readFile(preview))]).toEqual([...jpegBytes]);
      const subtitlePath = path.replace(/\.[^.]+$/, ".en.srt");
      await writeFile(
        join(files.dir, "media", subtitlePath),
        "1\n00:00:00,000 --> 00:00:01,000\nCLI subtitle\n",
      );
      expect(
        (await run("subtitles list", ["--path", path])).tracks,
      ).toHaveLength(1);
      const subtitle = await run("subtitle get", ["--path", subtitlePath]);
      expect(subtitle.stdout).toContain("WEBVTT");
      expect(subtitle.stdout).toContain("CLI subtitle");
      expect(
        (
          await run(
            "progress set",
            jsonArgs({ path, time: 5, duration: 100, watched: false }),
          )
        ).progress.time,
      ).toBe(5);
    }
    await run(`${group}s delete`, ["--id", id]);
    if (name === "music") {
      await run("track delete", ["--path", path]);
    } else {
      const trashed = await run(`${item} trash`, ["--path", path]);
      expect(trashed.batchId).toBeTruthy();
      expect((await run("library list"))[name]).toHaveLength(0);
      await run("trash restore", jsonArgs({ batchId: trashed.batchId }));
      expect((await run("library list"))[name]).toHaveLength(1);
      const second = await run("upload", ["--upload", local]);
      await run(`${item} trash`, [
        "--path",
        path,
        "--path",
        second.uploaded[0],
      ]);
      await run("trash empty");
      expect((await run("library list")).trash).toHaveLength(0);
    }
    expect(
      (await run("library list"))[item === "track" ? "tracks" : name],
    ).toHaveLength(0);
    const bad = join(files.dir, "bad.txt");
    await writeFile(bad, "not media");
    const failure = await cli(["upload", "--upload", bad], {
      baseUrl: app.baseUrl,
    });
    expect(failure.code).toBe(1);
    expect(failure.value.rejected).toHaveLength(1);
    expect([...seen].sort()).toEqual(config.commands.map((c) => c.name).sort());
  } finally {
    await app?.stop();
    await files.cleanup();
  }
}, 30000);
