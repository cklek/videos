const headless = process.env.HEADLESS === "1";
const index = headless ? null : (await import("./index.html")).default;
import mcpConfig from "./src/mcp/tools.js";
import { createMcpHttpHandler, loopbackUrl } from "./src/mcp/runtime.js";
import {
  LibraryError,
  createCollection,
  createLibrary,
  deleteCollection,
  emptyTrash,
  fallbackPosterSvg,
  listLibrary,
  parseRange,
  posterFile,
  restoreTrash,
  saveUpload,
  savePoster,
  scan,
  setFavorite,
  setOverride,
  setProgress,
  subtitleText,
  subtitleTracks,
  trashVideos,
  updateCollection,
  videoFile,
} from "./src/server/library.js";

const library = createLibrary({
  videosDir: process.env.VIDEOS_DIR || "./videos",
  dataDir: process.env.VIDEOS_DATA_DIR || "./data",
});

const json = (body, status = 200) => Response.json(body, { status });

async function jsonBody(req) {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

function wrap(handler) {
  return async (req) => {
    try {
      return await handler(req, new URL(req.url));
    } catch (error) {
      if (error instanceof LibraryError)
        return json({ error: error.message }, error.status);
      return json(
        { error: error instanceof Error ? error.message : "Request failed." },
        500,
      );
    }
  };
}

function collectionId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0)
    throw new LibraryError("Invalid collection id.");
  return id;
}

/* MCP over streamable HTTP: the same API, as tools. The handler calls back
 * into this server over loopback, so it needs the address after the fact. */
const mcp = createMcpHttpHandler(mcpConfig, {
  baseUrl: () => loopbackUrl(server),
});

const server = Bun.serve({
  port: Number(process.env.PORT || 3000),
  hostname: process.env.HOST || "0.0.0.0",
  development: process.env.NODE_ENV !== "production",
  idleTimeout: 240,
  maxRequestBodySize: 8 * 1024 * 1024 * 1024,
  routes: {
    ...(headless ? {} : { "/": index }),
    "/api/library": {
      GET: wrap(async (req, url) => {
        if (url.searchParams.get("rescan") === "1") await scan(library);
        return json(await listLibrary(library));
      }),
    },
    "/api/rescan": {
      POST: wrap(async (req, url) =>
        json(
          await scan(library, { force: url.searchParams.get("force") === "1" }),
        ),
      ),
    },
    "/api/file": {
      GET: wrap(async (req, url) => {
        const { fullPath, size, contentType } = await videoFile(
          library,
          url.searchParams.get("path"),
        );
        const range = parseRange(req.headers.get("range"), size);
        const headers = {
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=3600",
          "Content-Type": contentType,
        };
        if (range) {
          return new Response(
            Bun.file(fullPath).slice(range.start, range.end + 1),
            {
              status: 206,
              headers: {
                ...headers,
                "Content-Length": String(range.end - range.start + 1),
                "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
              },
            },
          );
        }
        return new Response(Bun.file(fullPath), {
          headers: { ...headers, "Content-Length": String(size) },
        });
      }),
    },
    "/api/poster": {
      GET: wrap(async (req, url) => {
        const relativePath = url.searchParams.get("path") || "";
        const poster = await posterFile(library, relativePath);
        if (poster) {
          return new Response(Bun.file(poster.fullPath), {
            headers: {
              "Content-Type": poster.contentType,
              "Cache-Control": "private, max-age=86400",
            },
          });
        }
        return new Response(fallbackPosterSvg(relativePath), {
          headers: {
            "Content-Type": "image/svg+xml; charset=utf-8",
            "Cache-Control": "private, max-age=86400",
          },
        });
      }),
      POST: wrap(async (req, url) => {
        const bytes = new Uint8Array(await req.arrayBuffer());
        return json(
          await savePoster(library, url.searchParams.get("path"), bytes),
        );
      }),
    },
    "/api/subtitles": {
      GET: wrap(async (req, url) =>
        json({
          tracks: await subtitleTracks(library, url.searchParams.get("path")),
        }),
      ),
    },
    "/api/subtitle": {
      GET: wrap(async (req, url) => {
        const text = await subtitleText(library, url.searchParams.get("path"));
        return new Response(text, {
          headers: {
            "Content-Type": "text/vtt; charset=utf-8",
            "Cache-Control": "private, max-age=3600",
          },
        });
      }),
    },
    "/api/upload": {
      POST: wrap(async (req) => {
        const form = await req.formData().catch(() => null);
        if (!form) return json({ error: "Expected multipart form data." }, 400);
        const uploaded = [];
        const rejected = [];
        for (const entry of form.getAll("files")) {
          try {
            uploaded.push(await saveUpload(library, entry));
          } catch (error) {
            rejected.push({
              name: entry?.name || "file",
              error: error instanceof Error ? error.message : "Rejected.",
            });
          }
        }
        if (uploaded.length) await scan(library);
        return json({ uploaded, rejected });
      }),
    },
    "/api/video": {
      PATCH: wrap(async (req) => {
        const body = await jsonBody(req);
        if (!body) return json({ error: "Invalid JSON body" }, 400);
        return json(await setOverride(library, body.path, body));
      }),
      DELETE: wrap(async (req, url) =>
        json(await trashVideos(library, url.searchParams.getAll("path"))),
      ),
    },
    "/api/favorite": {
      POST: wrap(async (req) => {
        const body = await jsonBody(req);
        if (!body) return json({ error: "Invalid JSON body" }, 400);
        return json(
          await setFavorite(library, body.path, body.favorite !== false),
        );
      }),
    },
    "/api/progress": {
      POST: wrap(async (req) => {
        const body = await jsonBody(req);
        if (!body) return json({ error: "Invalid JSON body" }, 400);
        return json(await setProgress(library, body.path, body));
      }),
    },
    "/api/trash": {
      POST: wrap(async (req) => {
        const body = await jsonBody(req);
        if (!body?.batchId) return json({ error: "batchId is required." }, 400);
        return json(await restoreTrash(library, String(body.batchId)));
      }),
      DELETE: wrap(async () => json(await emptyTrash(library))),
    },
    "/api/collections": {
      POST: wrap(async (req) => {
        const body = await jsonBody(req);
        if (!body) return json({ error: "Invalid JSON body" }, 400);
        return json(await createCollection(library, body), 201);
      }),
    },
    "/api/collections/:id": {
      PATCH: wrap(async (req) => {
        const body = await jsonBody(req);
        if (!body) return json({ error: "Invalid JSON body" }, 400);
        return json(await updateCollection(library, collectionId(req), body));
      }),
      DELETE: wrap(async (req) =>
        json(await deleteCollection(library, collectionId(req))),
      ),
    },
    "/mcp": mcp,
    "/api/*": () => json({ error: "Not found" }, 404),
  },
  fetch: () => headless ? json({ error: "Not found" }, 404) : new Response(index),
});

scan(library)
  .then((result) =>
    console.log(
      `videos  http://localhost:${server.port}  ${result.count} files in ${library.videosDir} (${result.probed} newly read)`,
    ),
  )
  .catch((error) => console.error("scan failed:", error));
