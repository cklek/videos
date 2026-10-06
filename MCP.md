# videos MCP server

The app is a [Model Context Protocol](https://modelcontextprotocol.io) server:
every HTTP API route is a tool, so an agent can drive videos the way the page
and the headless CLI do. The tools call the same `/api` routes, so what a
tool can do is exactly what the API can do, no more and no less.

There are two ways in:

- **Streamable HTTP**, built into the app server at `POST /mcp`. It is there
  whenever the app is running, in `bun dev`, `bun start` or
  `bun run headless`. Nothing extra to start.
- **stdio**, `bun run mcp`, for clients that launch a server process. It
  connects to a running app server, or starts its own API-only one with
  `--start`.

## Connect

With the app running on port 3000:

```sh
claude mcp add --transport http videos http://localhost:3000/mcp
```

For a client that launches processes (Claude Desktop, Codex, Claude Code with
stdio), point it at `mcp.js` and let it start its own server:

```json
{
  "mcpServers": {
    "videos": {
      "command": "bun",
      "args": ["/path/to/videos/mcp.js", "--start"]
    }
  }
}
```

`--start` runs `HEADLESS=1 HOST=127.0.0.1 PORT=0 bun server.js` from this
repository, with the same data directory and environment as `bun dev`, and
stops it when the client disconnects. Do not use it while another server is
already running against the same data directory: connect to that server
instead. Without `--start`, the URL precedence is `--base-url`, then
`VIDEOS_API_URL`, then `http://localhost:3000`. `bun run mcp --help` lists the
tools without needing a server.

The package declares the `videos-mcp` executable, available after an optional
`bun link`, alongside `videos-cli`.

## Tools

| Tool                        | HTTP API                      | Purpose                                                                                                                                                    |
| --------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `videos_library_list`       | `GET /api/library`            | Every video with its metadata and progress, favorites, the collections, and the trash batches.                                                             |
| `videos_rescan`             | `POST /api/rescan`            | Walk the videos folder again, picking up files added outside the app. force re-probes every file.                                                          |
| `videos_file_get`           | `GET /api/file`               | The video file. Answers with a link to the API (videos are too large to inline); output saves the file locally instead.                                    |
| `videos_poster_get`         | `GET /api/poster`             | The poster image: a sidecar image, a captured frame, or a generated SVG placeholder. Images come back inline; output saves the file locally instead.       |
| `videos_upload`             | `POST /api/upload`            | Add video files from the local disk (paths on the machine running the app). Returns the library paths under uploaded and any refused files under rejected. |
| `videos_video_update`       | `PATCH /api/video`            | Set a video's title, description or tags. Passing an empty value clears that field; reset clears all three.                                                |
| `videos_video_trash`        | `DELETE /api/video`           | Move videos to the trash as one batch. Returns the batchId that videos_trash_restore takes.                                                                |
| `videos_favorite_set`       | `POST /api/favorite`          | Mark or unmark a video as a favorite.                                                                                                                      |
| `videos_collections_create` | `POST /api/collections`       | Create a collection, optionally with videos in it.                                                                                                         |
| `videos_collections_update` | `PATCH /api/collections/:id`  | Rename a collection, replace its videos with paths, or change them with add and remove.                                                                    |
| `videos_collections_delete` | `DELETE /api/collections/:id` | Delete a collection. The videos stay in the library.                                                                                                       |
| `videos_trash_restore`      | `POST /api/trash`             | Put a trashed batch back where it came from.                                                                                                               |
| `videos_trash_empty`        | `DELETE /api/trash`           | Permanently delete everything in the trash. Cannot be undone.                                                                                              |
| `videos_poster_save`        | `POST /api/poster`            | Keep a JPEG from the local disk as the video's poster (what the page does with a captured frame).                                                          |
| `videos_subtitles_list`     | `GET /api/subtitles`          | The subtitle files (.srt or .vtt) sitting beside a video, with their language labels and API URLs.                                                         |
| `videos_subtitle_get`       | `GET /api/subtitle`           | One subtitle file as WebVTT text. path is the subtitle file's path (from videos_subtitles_list), not the video's.                                          |
| `videos_progress_set`       | `POST /api/progress`          | Record where playback got to. A time near the end marks the video watched and rewinds it; watched can be set explicitly.                                   |

Every tool takes one JSON object. Its schema (from `tools/list`) names each
argument and marks the required ones; the runtime rejects a missing required
argument, a wrong type, a value outside an enum, or an argument the tool does
not have, before anything is sent. Path parameters (`:id`) and query
parameters are filled from the arguments of the same name; whatever is left
becomes the JSON body. The API applies its own domain rules after that, the
same ones the page and the CLI get.

Paths in these examples are illustrative: use the exact path `videos_upload`
or `videos_library_list` returns. Video files are never inlined:
`videos_file_get` answers with a link to the API unless `output` names a
local file to save to. Posters that are real images come back inline; a
generated placeholder comes back as SVG text.

## Examples

Tool calls, as name and arguments:

```
videos_library_list {}
videos_upload {"files":["/home/me/Videos/clip.mp4"]}
videos_poster_get {"path":"2026/2026-09-06/clip.mp4"}
videos_file_get {"path":"2026/2026-09-06/clip.mp4","output":"/tmp/clip.mp4"}
videos_subtitles_list {"path":"2026/2026-09-06/clip.mp4"}
videos_progress_set {"path":"2026/2026-09-06/clip.mp4","time":421.5,"duration":1800}
```

## Results

- A JSON reply comes back twice: pretty-printed as a `text` block, and as
  `structuredContent` for clients that read it. `isError` is set when the
  API answered an error status (the payload then carries `error`, `status`
  and `details`), when a notebook cell run failed, or when every uploaded
  file was rejected. A partly rejected upload or a feed that failed inside a
  successful list is a success whose payload says what went wrong.
- Upload tools take `files`: paths on the machine running the app, sent as
  multipart `files`; any other argument becomes a text field.
- `videos_poster_save` takes `file`: a local JPEG whose bytes are the
  request body.
- Download tools (the ones that return bytes) answer with an `image` block
  when the reply is an image under 3 MB (`MCP_INLINE_IMAGE_BYTES` changes the
  limit), a `text` block when it is text or SVG, and otherwise a
  `resource_link` to the API URL. `output` saves the bytes to a local file
  instead and answers with the path and size; an existing file is replaced
  only after the whole reply arrived.
- `notifications/cancelled` aborts the API request behind a call. A call
  that has not answered after 300 seconds is an error.

## Verification

```sh
bun run test:mcp     # protocol, transport and every tool against a real server
bun run test         # the CLI suite too
```
