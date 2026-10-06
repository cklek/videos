# videos

A video library over a folder on disk. It plays what you already have, keeps
your place in each file, and remembers what you tell it — a title, a
description, tags, a star. Nothing is transcoded, nothing is uploaded
anywhere, and nothing is written back into your files.

## Requirements

- [Bun](https://bun.sh)

## Run it

```sh
bun install
bun dev          # http://localhost:3000
```

Point it at a folder with `VIDEOS_DIR` (default `./videos`); the tag cache,
your notes, the posters and the trash go under `VIDEOS_DATA_DIR` (default
`./data`). `PORT` changes the port.

```sh
VIDEOS_DIR=~/Movies bun dev
```

## Keys

`/` searches, `Enter` opens the first video, `Escape` goes back to the grid,
and `N` and `P` walk the queue. Going back while something is playing keeps
it playing in a small player in the corner of the library: its title opens
it back up, and its close button, or `Escape`, lets it go. The URL carries
`?view=`, `?folder=`, `?collection=`, `?tag=`, `?q=` and `?video=`, so any
view — or any video, at its place in your queue — is a link.

## What it reads

`.mp4 .m4v .mov .webm .mkv .avi .mpg .mpeg .ogv .wmv .3gp` are listed. What
plays is up to your browser — the file is streamed as it is, so a container
your browser cannot decode will say so rather than being converted behind
your back.

A file is read once and remembered by its size and modification time, so the
second start is instant. The length and the picture size come out of the
container itself: an `.mp4`, `.m4v`, `.mov` or `.3gp` is an ISO base media
file, so its `moov` is found and its `mvhd` and `tkhd` unpacked; a `.webm` or
`.mkv` is EBML, so its `Info` and `Video` elements are read. Nothing shells
out and there is nothing to install. A container that isn't one of those —
an `.avi`, say — simply has no length until the browser reports one back the
first time you play it.

Posters, in order: an image beside the file (`clip.jpg`, or a shared
`poster` / `cover` / `folder` / `thumb` in the folder), then a frame the page
grabbed the first time you opened the video and posted back to
`data/posters/`, then two letters on a gradient. The browser has already
decoded the frame, so that is the whole thumbnailer.

Subtitles are the `.vtt` or `.srt` files sitting beside the video —
`talk.srt` is unlabelled, `talk.en.srt` is English — and SRT is turned into
WebVTT on the way out.

## API

| Route                           | What                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `GET /api/library`              | Every video, the collections, and what is in the trash     |
| `POST /api/rescan?force=1`      | Walk the folder again; `force` re-probes every file        |
| `GET /api/file?path=`           | The video, with range requests                             |
| `GET /api/poster?path=`         | Sidecar image, captured frame, or a generated one          |
| `POST /api/poster?path=`        | Keep this JPEG as the poster — what the page posts back    |
| `GET /api/subtitles?path=`      | The subtitle files beside a video                          |
| `GET /api/subtitle?path=`       | One of them, as WebVTT                                     |
| `POST /api/upload`              | Multipart `files`, filed under `YYYY/YYYY-MM-DD/`          |
| `PATCH /api/video`              | `path` plus `title`, `description`, `tags`, or `reset`     |
| `DELETE /api/video?path=&path=` | Move videos to the trash in one batch; returns a `batchId` |
| `POST /api/progress`            | `path`, `time`, `duration?`, `watched?` — where you got to |
| `POST /api/favorite`            | `path`, `favorite`                                         |
| `POST /api/trash`               | `batchId` — put that batch back where it came from         |
| `DELETE /api/trash`             | Empty the trash for good                                   |
| `POST /api/collections`         | `name`, `paths`                                            |
| `PATCH /api/collections/:id`    | `name`, `paths`, or `add` / `remove`                       |
| `DELETE /api/collections/:id`   | Remove the collection, not the videos                      |

A path is always relative to the videos folder, with forward slashes and no
dot segments; anything else is refused rather than normalised. Errors come
back as `{ error }`.

## Where things go

A delete is a move into `data/trash/<batch>/` that keeps the video's place in
the folder tree, along with the star, notes and position it had, so undo is
the same move backwards. Emptying the trash is the only thing that takes a
file off the disk.

| Path                    | What                                                  |
| ----------------------- | ----------------------------------------------------- |
| `src/app/`              | The page, the player, and its API client              |
| `src/app/library.js`    | Searching, grouping, and what counts as started       |
| `src/server/library.js` | The folder: the scan, the container probes, the trash |
| `server.js`             | `Bun.serve`: the page plus `/api`                     |
| `src/ui/`               | shadcn primitives (generated), the icon glyphs in use |
| `src/shell/`            | App frame: layout, menubar, `useAppMenu`, dialogs     |

## CLI and MCP

Every API route is reachable from the command line and as an MCP tool.

`bun run cli` reaches every route. Start an API-only server with
`HOST=127.0.0.1 bun run headless`, or point the CLI at a running web server.
Run `bun run cli --help` for commands; `VIDEOS_API_URL` or `--base-url`
selects the server. The executable is also declared as `videos-cli` for
`bun link`. See [CLI.md](CLI.md) for examples, every command, file and
streaming I/O, exit codes, and `bun run test:cli` verification.

The app is an MCP server too: every route is a tool, over streamable HTTP at
`POST /mcp` on the running server, or over stdio with `bun run mcp`
(`--start` gives it an API-only server of its own). Connect an agent over
HTTP with:

```sh
claude mcp add --transport http videos http://localhost:3000/mcp
```

Or point a stdio client at `bun run mcp --start`. The executable is declared
as `videos-mcp`. See [MCP.md](MCP.md) for connecting, every tool, how files
and results are handled, and `bun run test:mcp` verification.

## License

MIT — see [LICENSE](LICENSE).
