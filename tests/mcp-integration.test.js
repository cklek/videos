import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import config from "../src/mcp/tools.js";
import { compileTools } from "../src/mcp/runtime.js";
import { connect, fixture, startApp } from "./mcp-helpers.js";

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

test(`every ${config.app} MCP tool operates on isolated media, bytes and saved groups`, async () => {
  const files = await fixture();
  let app;
  const name = config.app;
  const item = { music: "track", videos: "video", photos: "photo" }[name];
  const group = { music: "playlist", videos: "collection", photos: "album" }[
    name
  ];
  const art = { music: "art", videos: "poster", photos: "thumb" }[name];
  const listKey = item === "track" ? "tracks" : name;
  const t = (suffix) => `${name}_${suffix}`;
  try {
    app = await startApp(files.dir);
    const mcp = connect(app.baseUrl);
    await mcp.initialize();
    const media = mediaFixture(name);
    const local = join(files.dir, `A & B.${media.extension}`);
    await writeFile(local, media.bytes);
    const upload = await mcp.tool(t("upload"), { files: [local] });
    expect(upload.uploaded).toHaveLength(1);
    const path = upload.uploaded[0];
    const library = await mcp.tool(t("library_list"), { rescan: true });
    expect(library[listKey].some((entry) => entry.path === path)).toBe(true);
    expect((await mcp.tool(t("rescan"), { force: true })).count).toBe(1);
    const output = join(files.dir, "download.bin");
    const saved = await mcp.tool(t("file_get"), { path, output });
    expect(saved).toMatchObject({ saved: output, size: media.bytes.length });
    expect(await readFile(output)).toEqual(media.bytes);
    const inline = await mcp.result(t("file_get"), { path });
    expect(inline.isError).toBeUndefined();
    if (name === "photos") {
      expect(inline.content[0]).toMatchObject({
        type: "image",
        mimeType: "image/png",
      });
      expect(Buffer.from(inline.content[0].data, "base64")).toEqual(
        media.bytes,
      );
    } else {
      expect(inline.content[0].type).toBe("resource_link");
      expect(inline.content[0].uri).toContain("/api/file?path=");
      expect(inline.content[0].mimeType).toMatch(
        name === "videos" ? /^video\// : /^audio\//,
      );
    }
    const preview = join(files.dir, "preview.bin");
    const art1 = await mcp.tool(t(`${art}_get`), { path, output: preview });
    expect(art1.size).toBeGreaterThan(0);
    expect((await readFile(preview)).length).toBe(art1.size);
    const artInline = await mcp.result(t(`${art}_get`), { path });
    expect(artInline.isError).toBeUndefined();
    if (name === "photos") expect(artInline.content[0].type).toBe("image");
    else expect(artInline.content[0].text).toContain("<svg");
    expect(
      (await mcp.tool(t(`${item}_update`), { path, title: "MCP title" }))
        .override.title,
    ).toBe("MCP title");
    await mcp.tool(t("favorite_set"), { path, favorite: true });
    const created = await mcp.tool(t(`${group}s_create`), {
      name: "MCP group",
      paths: [path],
    });
    const id = created[group].id;
    expect(
      (
        await mcp.tool(t(`${group}s_update`), {
          id,
          name: "Renamed",
          paths: [path],
        })
      )[group].name,
    ).toBe("Renamed");
    const updated = await mcp.tool(t("library_list"));
    expect(updated[listKey].find((entry) => entry.path === path)).toMatchObject(
      { title: "MCP title", favorite: true },
    );
    expect(updated[`${group}s`].find((entry) => entry.id === id).name).toBe(
      "Renamed",
    );
    if (name === "videos") {
      const jpeg = join(files.dir, "poster.jpg");
      const jpegBytes = new Uint8Array([255, 216, 255, 217]);
      await writeFile(jpeg, jpegBytes);
      expect(
        (await mcp.tool("videos_poster_save", { path, file: jpeg })).poster,
      ).toBe(true);
      await mcp.tool("videos_poster_get", { path, output: preview });
      expect([...(await readFile(preview))]).toEqual([...jpegBytes]);
      const subtitlePath = path.replace(/\.[^.]+$/, ".en.srt");
      await writeFile(
        join(files.dir, "media", subtitlePath),
        "1\n00:00:00,000 --> 00:00:01,000\nMCP subtitle\n",
      );
      expect(
        (await mcp.tool("videos_subtitles_list", { path })).tracks,
      ).toHaveLength(1);
      const subtitle = await mcp.result("videos_subtitle_get", {
        path: subtitlePath,
      });
      expect(subtitle.content[0].text).toContain("WEBVTT");
      expect(subtitle.content[0].text).toContain("MCP subtitle");
      expect(
        (
          await mcp.tool("videos_progress_set", {
            path,
            time: 5,
            duration: 100,
            watched: false,
          })
        ).progress.time,
      ).toBe(5);
    }
    await mcp.tool(t(`${group}s_delete`), { id });
    if (name === "music") {
      expect((await mcp.tool("music_track_delete", { path })).deleted).toBe(
        true,
      );
    } else {
      const trashed = await mcp.tool(t(`${item}_trash`), { paths: [path] });
      expect(trashed.batchId).toBeTruthy();
      expect((await mcp.tool(t("library_list")))[name]).toHaveLength(0);
      await mcp.tool(t("trash_restore"), { batchId: trashed.batchId });
      expect((await mcp.tool(t("library_list")))[name]).toHaveLength(1);
      const second = await mcp.tool(t("upload"), { files: [local] });
      await mcp.tool(t(`${item}_trash`), { paths: [path, second.uploaded[0]] });
      await mcp.tool(t("trash_empty"));
      expect((await mcp.tool(t("library_list"))).trash).toHaveLength(0);
    }
    expect((await mcp.tool(t("library_list")))[listKey]).toHaveLength(0);
    const bad = join(files.dir, "bad.txt");
    await writeFile(bad, "not media");
    const failure = await mcp.tool(
      t("upload"),
      { files: [bad] },
      { expectError: true },
    );
    expect(failure.rejected).toHaveLength(1);
    expect([...mcp.seen].sort()).toEqual(
      compileTools(config)
        .map((tool) => tool.name)
        .sort(),
    );
  } finally {
    await app?.stop();
    await files.cleanup();
  }
}, 30000);
