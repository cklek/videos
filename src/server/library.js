import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const VIDEO_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".webm",
  ".wmv",
]);
const SUBTITLE_EXTENSIONS = new Set([".srt", ".vtt"]);
const POSTER_EXTENSIONS = new Set([".avif", ".jpeg", ".jpg", ".png", ".webp"]);
const POSTER_STEMS = new Set([
  "cover",
  "folder",
  "poster",
  "thumb",
  "thumbnail",
]);
const CONTENT_TYPES = {
  ".3gp": "video/3gpp",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".ogv": "video/ogg",
  ".webm": "video/webm",
  ".wmv": "video/x-ms-wmv",
  ".avif": "image/avif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
};
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_POSTER_BYTES = 4 * 1024 * 1024;
const MAX_MOOV_BYTES = 8 * 1024 * 1024;
const EBML_HEAD_BYTES = 4 * 1024 * 1024;
const MAX_TAGS = 16;
const WATCHED_FRACTION = 0.92;

export class LibraryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function contentTypeFor(name) {
  return (
    CONTENT_TYPES[path.extname(name).toLowerCase()] ||
    "application/octet-stream"
  );
}

export function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function cleanRelativePath(value) {
  const text = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!text) return "";
  const parts = text.split("/");
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part.startsWith("."),
    )
  )
    return "";
  return parts.join("/");
}

function cleanText(value, max = 400) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function titleFromPath(relativePath) {
  const stem = (relativePath.split("/").at(-1) || relativePath).replace(
    /\.[^.]+$/,
    "",
  );
  const spaced = stem.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  const cut = spaced.replace(
    /\s+(19|20)\d{2}\b.*$|\s+\d{3,4}p\b.*$|\s+(x26[45]|h\.?26[45]|hevc|bluray|web-?dl|webrip|hdtv|dvdrip|remux|proper|repack)\b.*$/i,
    "",
  );
  return cleanText(cut || spaced || stem, 200);
}

export function episodeFromPath(relativePath) {
  const name = relativePath.split("/").at(-1) || "";
  const match =
    name.match(/\bS(\d{1,2})[\s._-]?E(\d{1,3})\b/i) ||
    name.match(/\b(\d{1,2})x(\d{1,3})\b/);
  if (!match) return null;
  return { season: Number(match[1]), episode: Number(match[2]) };
}

export function createLibrary({ videosDir, dataDir }) {
  const resolvedData = path.resolve(dataDir);
  return {
    videosDir: path.resolve(videosDir),
    dataDir: resolvedData,
    indexFile: path.join(resolvedData, "index.json"),
    stateFile: path.join(resolvedData, "library.json"),
    posterDir: path.join(resolvedData, "posters"),
    trashDir: path.join(resolvedData, "trash"),
    index: null,
    state: null,
    scanning: null,
    queue: Promise.resolve(),
  };
}

function absolutePath(library, relativePath) {
  const clean = cleanRelativePath(relativePath);
  if (!clean) return null;
  const full = path.join(library.videosDir, clean);
  if (!full.startsWith(library.videosDir + path.sep)) return null;
  return full;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, file);
}

function locked(library, task) {
  const next = library.queue.then(task, task);
  library.queue = next.catch(() => {});
  return next;
}

async function loadState(library) {
  if (library.state) return library.state;
  const parsed = await readJson(library.stateFile, {});
  library.state = {
    favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
    collections: Array.isArray(parsed.collections) ? parsed.collections : [],
    overrides:
      parsed.overrides && typeof parsed.overrides === "object"
        ? parsed.overrides
        : {},
    progress:
      parsed.progress && typeof parsed.progress === "object"
        ? parsed.progress
        : {},
    trash: Array.isArray(parsed.trash) ? parsed.trash : [],
    nextCollectionId: Number(parsed.nextCollectionId) || 1,
  };
  return library.state;
}

function saveState(library) {
  return writeJson(library.stateFile, library.state);
}

async function readAt(handle, position, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function parseMoov(buffer) {
  let duration = null;
  let width = 0;
  let height = 0;
  const walk = (start, end) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = buffer.readUInt32BE(offset);
      const type = buffer.toString("latin1", offset + 4, offset + 8);
      let headerSize = 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        size = Number(buffer.readBigUInt64BE(offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) break;
      const body = offset + headerSize;
      if (type === "mvhd" && body + 20 <= end) {
        const version = buffer.readUInt8(body);
        if (version === 1 && body + 32 <= end) {
          const timescale = buffer.readUInt32BE(body + 20);
          const units = Number(buffer.readBigUInt64BE(body + 24));
          if (timescale > 0) duration = units / timescale;
        } else {
          const timescale = buffer.readUInt32BE(body + 12);
          const units = buffer.readUInt32BE(body + 16);
          if (timescale > 0) duration = units / timescale;
        }
      } else if (type === "tkhd") {
        const version = buffer.readUInt8(body);
        const matrixEnd = body + (version === 1 ? 88 : 76);
        if (matrixEnd + 8 <= end) {
          const trackWidth = buffer.readUInt32BE(matrixEnd) / 65536;
          const trackHeight = buffer.readUInt32BE(matrixEnd + 4) / 65536;
          if (trackWidth >= 1 && trackHeight >= 1) {
            width = Math.max(width, Math.round(trackWidth));
            height = Math.max(height, Math.round(trackHeight));
          }
        }
      } else if (
        type === "trak" ||
        type === "mdia" ||
        type === "minf" ||
        type === "stbl"
      ) {
        walk(body, offset + size);
      }
      offset += size;
    }
  };
  walk(0, buffer.length);
  return { duration, width: width || null, height: height || null };
}

async function probeIsoBmff(handle, size) {
  let offset = 0;
  while (offset + 8 <= size) {
    const header = await readAt(handle, offset, 16);
    if (header.length < 8) break;
    let boxSize = header.readUInt32BE(0);
    const type = header.toString("latin1", 4, 8);
    let headerSize = 8;
    if (boxSize === 1) {
      if (header.length < 16) break;
      boxSize = Number(header.readBigUInt64BE(8));
      headerSize = 16;
    } else if (boxSize === 0) {
      boxSize = size - offset;
    }
    if (!Number.isFinite(boxSize) || boxSize < headerSize) break;
    if (type === "moov") {
      const length = Math.min(boxSize - headerSize, MAX_MOOV_BYTES);
      return parseMoov(await readAt(handle, offset + headerSize, length));
    }
    offset += boxSize;
  }
  return null;
}

function readVint(buffer, offset, keepMarker) {
  if (offset >= buffer.length) return null;
  const first = buffer[offset];
  if (first === 0) return null;
  let width = 1;
  let mask = 0x80;
  while (width <= 8 && !(first & mask)) {
    width += 1;
    mask >>= 1;
  }
  if (width > 8 || offset + width > buffer.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  for (let index = 1; index < width; index += 1)
    value = value * 256 + buffer[offset + index];
  return { value, width };
}

function parseEbml(buffer) {
  let timecodeScale = 1_000_000;
  let duration = null;
  let width = null;
  let height = null;
  let trackType = null;
  const walk = (start, end, depth) => {
    let offset = start;
    while (offset < end && depth < 8) {
      const id = readVint(buffer, offset, true);
      if (!id) return;
      const size = readVint(buffer, offset + id.width, false);
      if (!size) return;
      const body = offset + id.width + size.width;
      const stop = Math.min(body + size.value, end);
      if (body > end) return;
      switch (id.value) {
        case 0x18538067:
        case 0x1549a966:
        case 0x1654ae6b:
        case 0xae:
        case 0xe0:
          walk(body, stop, depth + 1);
          break;
        case 0x2ad7b1: {
          let value = 0;
          for (let index = body; index < stop; index += 1)
            value = value * 256 + buffer[index];
          if (value > 0) timecodeScale = value;
          break;
        }
        case 0x4489: {
          const length = stop - body;
          if (length === 4) duration = buffer.readFloatBE(body);
          else if (length === 8) duration = buffer.readDoubleBE(body);
          break;
        }
        case 0x83: {
          let value = 0;
          for (let index = body; index < stop; index += 1)
            value = value * 256 + buffer[index];
          trackType = value;
          break;
        }
        case 0xb0:
        case 0xba: {
          let value = 0;
          for (let index = body; index < stop; index += 1)
            value = value * 256 + buffer[index];
          if (trackType === null || trackType === 1) {
            if (id.value === 0xb0) width = Math.max(width || 0, value);
            else height = Math.max(height || 0, value);
          }
          break;
        }
        default:
          break;
      }
      offset = body + size.value;
      if (size.value <= 0) return;
    }
  };
  walk(0, buffer.length, 0);
  return {
    duration:
      duration === null ? null : (duration * timecodeScale) / 1_000_000_000,
    width: width || null,
    height: height || null,
  };
}

export async function probeVideo(fullPath) {
  const extension = path.extname(fullPath).toLowerCase();
  let handle;
  try {
    handle = await open(fullPath, "r");
    const info = await handle.stat();
    if (extension === ".webm" || extension === ".mkv") {
      const head = await readAt(
        handle,
        0,
        Math.min(EBML_HEAD_BYTES, info.size),
      );
      return parseEbml(head);
    }
    const box = await probeIsoBmff(handle, info.size);
    if (box) return box;
    return { duration: null, width: null, height: null };
  } catch {
    return { duration: null, width: null, height: null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function walk(library, dir, prefix, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      await walk(library, path.join(dir, entry.name), relative, out);
    else if (entry.isFile() && isVideoFile(entry.name)) out.push(relative);
  }
  return out;
}

export function scan(library, { force = false } = {}) {
  if (library.scanning) return library.scanning;
  library.scanning = (async () => {
    try {
      await mkdir(library.videosDir, { recursive: true });
      const previous = force
        ? {}
        : library.index || (await readJson(library.indexFile, {})).videos || {};
      const paths = await walk(library, library.videosDir, "", []);
      const videos = {};
      let probed = 0;
      for (const relativePath of paths) {
        const fullPath = path.join(library.videosDir, relativePath);
        const info = await stat(fullPath);
        const key = `${info.size}:${info.mtimeMs}`;
        const cached = previous[relativePath];
        if (cached && cached.key === key) {
          videos[relativePath] = cached;
          continue;
        }
        probed += 1;
        const probe = await probeVideo(fullPath);
        videos[relativePath] = {
          key,
          size: info.size,
          updatedAt: info.mtime.toISOString(),
          duration: Number.isFinite(probe.duration)
            ? Math.round(probe.duration * 10) / 10
            : null,
          width: probe.width,
          height: probe.height,
        };
      }
      library.index = videos;
      await writeJson(library.indexFile, {
        version: 1,
        scannedAt: new Date().toISOString(),
        videos,
      });
      return { count: paths.length, probed };
    } finally {
      library.scanning = null;
    }
  })();
  return library.scanning;
}

function folderOf(relativePath) {
  const parts = relativePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function serializeVideo(relativePath, entry, state, poster) {
  const override = state.overrides[relativePath] || {};
  const progress = state.progress[relativePath] || {};
  const duration =
    entry.duration ??
    (Number.isFinite(progress.duration) ? progress.duration : null);
  const position = Number.isFinite(progress.time) ? progress.time : 0;
  return {
    path: relativePath,
    url: `/api/file?path=${encodeURIComponent(relativePath)}`,
    posterUrl: `/api/poster?path=${encodeURIComponent(relativePath)}`,
    poster,
    name: relativePath.split("/").at(-1),
    title: cleanText(override.title) || titleFromPath(relativePath),
    description: cleanText(override.description, 2000) || "",
    tags: Array.isArray(override.tags) ? override.tags : [],
    folder: folderOf(relativePath),
    episode: episodeFromPath(relativePath),
    duration,
    width: entry.width ?? progress.width ?? null,
    height: entry.height ?? progress.height ?? null,
    size: entry.size,
    updatedAt: entry.updatedAt,
    contentType: contentTypeFor(relativePath),
    favorite: state.favorites.includes(relativePath),
    edited: Object.keys(override).length > 0,
    position,
    watched: Boolean(progress.watched),
    playedAt: progress.updatedAt || null,
  };
}

async function posterKinds(library, paths) {
  const sidecars = new Map();
  const kinds = new Map();
  for (const relativePath of paths) {
    const folder = folderOf(relativePath);
    if (!sidecars.has(folder)) {
      const directory = path.join(library.videosDir, folder);
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        () => [],
      );
      sidecars.set(
        folder,
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              POSTER_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
          )
          .map((entry) => entry.name),
      );
    }
    const names = sidecars.get(folder);
    const stem = path
      .basename(relativePath, path.extname(relativePath))
      .toLowerCase();
    const hasSidecar = names.some((name) => {
      const base = path.basename(name, path.extname(name)).toLowerCase();
      return base === stem || POSTER_STEMS.has(base);
    });
    if (hasSidecar) {
      kinds.set(relativePath, "sidecar");
      continue;
    }
    const cached = posterCachePath(
      library,
      relativePath,
      library.index?.[relativePath]?.key,
    );
    const exists = await stat(cached)
      .then((info) => info.isFile())
      .catch(() => false);
    kinds.set(relativePath, exists ? "frame" : null);
  }
  return kinds;
}

export async function listLibrary(library) {
  if (!library.index) await scan(library);
  const state = await loadState(library);
  const kinds = await posterKinds(library, Object.keys(library.index));
  const videos = Object.entries(library.index)
    .map(([relativePath, entry]) =>
      serializeVideo(
        relativePath,
        entry,
        state,
        kinds.get(relativePath) || null,
      ),
    )
    .sort(
      (a, b) =>
        a.folder.localeCompare(b.folder) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
  return {
    videos,
    collections: state.collections,
    trash: state.trash.map((batch) => ({
      id: batch.id,
      deletedAt: batch.deletedAt,
      count: batch.items.length,
      names: batch.items.slice(0, 4).map((item) => item.path.split("/").at(-1)),
    })),
    videosDir: library.videosDir,
  };
}

export async function videoFile(library, relativePath) {
  const fullPath = absolutePath(library, relativePath);
  if (!fullPath || !isVideoFile(fullPath))
    throw new LibraryError("Invalid video path.");
  const info = await stat(fullPath).catch(() => null);
  if (!info || !info.isFile()) throw new LibraryError("Video not found.", 404);
  return { fullPath, size: info.size, contentType: contentTypeFor(fullPath) };
}

export function parseRange(value, size) {
  if (size <= 0 || !value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function posterCachePath(library, relativePath, key) {
  const hash = createHash("sha1")
    .update(`${relativePath}\n${key || ""}`)
    .digest("hex");
  return path.join(library.posterDir, `${hash}.jpg`);
}

async function sidecarPoster(library, relativePath) {
  const fullPath = path.join(library.videosDir, relativePath);
  const directory = path.dirname(fullPath);
  const stem = path.basename(fullPath, path.extname(fullPath)).toLowerCase();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  let folderPoster = null;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!POSTER_EXTENSIONS.has(extension)) continue;
    const base = path.basename(entry.name, extension).toLowerCase();
    if (base === stem) return path.join(directory, entry.name);
    if (!folderPoster && POSTER_STEMS.has(base))
      folderPoster = path.join(directory, entry.name);
  }
  return folderPoster;
}

export async function posterFile(library, relativePath) {
  const fullPath = absolutePath(library, relativePath);
  if (!fullPath) throw new LibraryError("Invalid video path.");
  const sidecar = await sidecarPoster(library, cleanRelativePath(relativePath));
  if (sidecar)
    return { fullPath: sidecar, contentType: contentTypeFor(sidecar) };
  const cached = posterCachePath(
    library,
    relativePath,
    library.index?.[relativePath]?.key,
  );
  if (
    await stat(cached)
      .then((info) => info.isFile())
      .catch(() => false)
  ) {
    return { fullPath: cached, contentType: "image/jpeg" };
  }
  return null;
}

export async function savePoster(library, relativePath, bytes) {
  const fullPath = absolutePath(library, relativePath);
  if (!fullPath) throw new LibraryError("Invalid video path.");
  if (!bytes?.length) throw new LibraryError("Empty poster.");
  if (bytes.length > MAX_POSTER_BYTES)
    throw new LibraryError("Poster is too large.");
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8))
    throw new LibraryError("Poster must be a JPEG.");
  const target = posterCachePath(
    library,
    relativePath,
    library.index?.[relativePath]?.key,
  );
  await mkdir(library.posterDir, { recursive: true });
  await writeFile(`${target}.tmp`, bytes);
  await rename(`${target}.tmp`, target);
  return { poster: true };
}

const FALLBACK_PALETTES = [
  ["#171717", "#9a3412", "#0f766e", "#fff7ed"],
  ["#18181b", "#881337", "#a16207", "#fff1f2"],
  ["#111827", "#155e75", "#365314", "#ecfeff"],
  ["#0a0a0a", "#7f1d1d", "#14532d", "#fef2f2"],
  ["#0f172a", "#1d4ed8", "#7c2d12", "#eff6ff"],
];

export function fallbackPosterSvg(relativePath) {
  const title = titleFromPath(relativePath) || "Video";
  const words = title.split(/\s+/).filter(Boolean);
  const strong = words.filter((word) => /^[\p{Lu}\p{N}]/u.test(word));
  const initials = (
    (strong.length ? strong : words)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join("") || "V"
  ).replace(/[<>&]/g, "");
  const hash = createHash("sha1")
    .update(folderOf(relativePath) || relativePath)
    .digest("hex");
  const [from, via, to, text] =
    FALLBACK_PALETTES[
      Number.parseInt(hash.slice(0, 8), 16) % FALLBACK_PALETTES.length
    ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="0.55" stop-color="${via}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><circle cx="530" cy="300" r="150" fill="#ffffff" opacity="0.12"/><text x="320" y="196" text-anchor="middle" fill="${text}" font-family="Georgia,serif" font-size="116" font-weight="700">${initials}</text></svg>`;
}

export async function subtitleTracks(library, relativePath) {
  const clean = cleanRelativePath(relativePath);
  if (!clean) return [];
  const fullPath = path.join(library.videosDir, clean);
  const directory = path.dirname(fullPath);
  const stem = path.basename(fullPath, path.extname(fullPath));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const tracks = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!SUBTITLE_EXTENSIONS.has(extension)) continue;
    const base = path.basename(entry.name, extension);
    if (base !== stem && !base.startsWith(`${stem}.`)) continue;
    const label = base === stem ? "Subtitles" : base.slice(stem.length + 1);
    const relative = path.posix.join(folderOf(clean), entry.name);
    tracks.push({
      label: cleanText(label, 40) || "Subtitles",
      language: /^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(label)
        ? label.toLowerCase()
        : "",
      url: `/api/subtitle?path=${encodeURIComponent(relative)}`,
    });
  }
  return tracks.sort((a, b) => a.label.localeCompare(b.label));
}

function srtToVtt(text) {
  const body = text
    .replace(/\r\n?/g, "\n")
    .replace(/^\ufeff/, "")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT\n\n${body.trim()}\n`;
}

export async function subtitleText(library, relativePath) {
  const fullPath = absolutePath(library, relativePath);
  if (!fullPath) throw new LibraryError("Invalid subtitle path.");
  const extension = path.extname(fullPath).toLowerCase();
  if (!SUBTITLE_EXTENSIONS.has(extension))
    throw new LibraryError("Not a subtitle file.");
  const text = await readFile(fullPath, "utf8").catch(() => null);
  if (text === null) throw new LibraryError("Subtitle not found.", 404);
  return extension === ".srt" ? srtToVtt(text) : text;
}

function safeSegment(value, fallback) {
  const text = cleanText(value)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return text || fallback;
}

export async function saveUpload(library, file) {
  if (!file || typeof file.name !== "string")
    throw new LibraryError("No file.");
  if (!isVideoFile(file.name))
    throw new LibraryError(`${file.name}: not a video file.`);
  if (file.size > MAX_UPLOAD_BYTES)
    throw new LibraryError(
      `${file.name}: over ${MAX_UPLOAD_BYTES / 1024 ** 3} GB.`,
    );
  const stamp = new Date(
    Number.isFinite(file.lastModified) && file.lastModified > 0
      ? file.lastModified
      : Date.now(),
  );
  const day = Number.isNaN(stamp.valueOf()) ? new Date() : stamp;
  const folder = path.posix.join(
    String(day.getFullYear()),
    day.toISOString().slice(0, 10),
  );
  await mkdir(path.join(library.videosDir, folder), { recursive: true });
  const extension = path.extname(file.name).toLowerCase();
  const fileName = `${safeSegment(path.basename(file.name, path.extname(file.name)), "video")}${extension}`;
  let relativePath = `${folder}/${fileName}`;
  for (
    let index = 2;
    await stat(path.join(library.videosDir, relativePath))
      .then(() => true)
      .catch(() => false);
    index += 1
  ) {
    relativePath = `${folder}/${fileName.replace(/(\.[^.]+)$/, ` (${index})$1`)}`;
  }
  const target = path.join(library.videosDir, relativePath);
  await writeFile(target, file.stream());
  return relativePath;
}

export function trashVideos(library, paths) {
  return locked(library, async () => {
    const state = await loadState(library);
    const wanted = [
      ...new Set(
        (Array.isArray(paths) ? paths : [])
          .map(cleanRelativePath)
          .filter(Boolean),
      ),
    ];
    if (!wanted.length) throw new LibraryError("Nothing to delete.");
    const batchId = `${Date.now().toString(36)}-${createHash("sha1").update(wanted.join("\n")).digest("hex").slice(0, 6)}`;
    const batchDir = path.join(library.trashDir, batchId);
    const items = [];
    for (const relativePath of wanted) {
      const fullPath = absolutePath(library, relativePath);
      if (!fullPath) continue;
      const info = await stat(fullPath).catch(() => null);
      if (!info || !info.isFile()) continue;
      const target = path.join(batchDir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      try {
        await rename(fullPath, target);
      } catch (error) {
        if (error?.code !== "EXDEV") throw error;
        await cp(fullPath, target);
        await rm(fullPath);
      }
      items.push({
        path: relativePath,
        favorite: state.favorites.includes(relativePath),
        override: state.overrides[relativePath] || null,
        progress: state.progress[relativePath] || null,
      });
      state.favorites = state.favorites.filter(
        (entry) => entry !== relativePath,
      );
      delete state.overrides[relativePath];
      delete state.progress[relativePath];
      for (const collection of state.collections) {
        collection.paths = collection.paths.filter(
          (entry) => entry !== relativePath,
        );
      }
      if (library.index) delete library.index[relativePath];
    }
    if (!items.length) throw new LibraryError("Nothing to delete.", 404);
    state.trash.unshift({
      id: batchId,
      deletedAt: new Date().toISOString(),
      items,
    });
    await saveState(library);
    return { batchId, count: items.length };
  });
}

export function restoreTrash(library, batchId) {
  return locked(library, async () => {
    const state = await loadState(library);
    const index = state.trash.findIndex((batch) => batch.id === batchId);
    if (index < 0) throw new LibraryError("Nothing to restore.", 404);
    const [batch] = state.trash.splice(index, 1);
    const batchDir = path.join(library.trashDir, batch.id);
    let restored = 0;
    for (const item of batch.items) {
      const source = path.join(batchDir, item.path);
      const target = path.join(library.videosDir, item.path);
      if (
        !(await stat(source)
          .then((info) => info.isFile())
          .catch(() => false))
      )
        continue;
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
      restored += 1;
      if (item.favorite) state.favorites.push(item.path);
      if (item.override) state.overrides[item.path] = item.override;
      if (item.progress) state.progress[item.path] = item.progress;
    }
    await rm(batchDir, { recursive: true, force: true });
    await saveState(library);
    library.index = null;
    return { restored };
  });
}

export function emptyTrash(library) {
  return locked(library, async () => {
    const state = await loadState(library);
    const removed = state.trash.reduce(
      (total, batch) => total + batch.items.length,
      0,
    );
    state.trash = [];
    await saveState(library);
    await rm(library.trashDir, { recursive: true, force: true });
    return { removed };
  });
}

export function setFavorite(library, relativePath, favorite) {
  return locked(library, async () => {
    if (!cleanRelativePath(relativePath))
      throw new LibraryError("Invalid video path.");
    const state = await loadState(library);
    const has = state.favorites.includes(relativePath);
    if (favorite && !has) state.favorites.push(relativePath);
    if (!favorite && has)
      state.favorites = state.favorites.filter(
        (entry) => entry !== relativePath,
      );
    await saveState(library);
    return { favorite: Boolean(favorite) };
  });
}

export function setOverride(library, relativePath, patch) {
  return locked(library, async () => {
    if (!cleanRelativePath(relativePath))
      throw new LibraryError("Invalid video path.");
    const state = await loadState(library);
    const current = { ...(state.overrides[relativePath] || {}) };
    if (Object.hasOwn(patch, "title")) {
      const value = cleanText(patch.title, 200);
      if (value) current.title = value;
      else delete current.title;
    }
    if (Object.hasOwn(patch, "description")) {
      const value = cleanText(patch.description, 2000);
      if (value) current.description = value;
      else delete current.description;
    }
    if (Object.hasOwn(patch, "tags")) {
      const tags = [
        ...new Set(
          (Array.isArray(patch.tags)
            ? patch.tags
            : String(patch.tags || "").split(",")
          )
            .map((tag) => cleanText(tag, 40).toLowerCase())
            .filter(Boolean),
        ),
      ].slice(0, MAX_TAGS);
      if (tags.length) current.tags = tags;
      else delete current.tags;
    }
    if (patch.reset)
      for (const key of Object.keys(current)) delete current[key];
    if (Object.keys(current).length) state.overrides[relativePath] = current;
    else delete state.overrides[relativePath];
    await saveState(library);
    return { override: state.overrides[relativePath] || null };
  });
}

export function setProgress(library, relativePath, patch) {
  return locked(library, async () => {
    if (!cleanRelativePath(relativePath))
      throw new LibraryError("Invalid video path.");
    const state = await loadState(library);
    const current = { ...(state.progress[relativePath] || {}) };
    const duration = Number(patch.duration);
    if (Number.isFinite(duration) && duration > 0)
      current.duration = Math.round(duration * 10) / 10;
    const time = Number(patch.time);
    if (Number.isFinite(time) && time >= 0)
      current.time = Math.round(time * 10) / 10;
    const width = Number(patch.width);
    const height = Number(patch.height);
    if (Number.isInteger(width) && width > 0) current.width = width;
    if (Number.isInteger(height) && height > 0) current.height = height;
    const known =
      current.duration || library.index?.[relativePath]?.duration || 0;
    if (typeof patch.watched === "boolean") current.watched = patch.watched;
    else if (known > 0 && current.time >= known * WATCHED_FRACTION)
      current.watched = true;
    if (
      current.watched &&
      known > 0 &&
      current.time >= known * WATCHED_FRACTION
    )
      current.time = 0;
    current.updatedAt = new Date().toISOString();
    state.progress[relativePath] = current;
    await saveState(library);
    return { progress: current };
  });
}

function cleanPaths(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .map(cleanRelativePath)
    .filter((entry) => entry && !seen.has(entry) && seen.add(entry));
}

export function createCollection(library, body) {
  return locked(library, async () => {
    const name = cleanText(body?.name, 120);
    if (!name) throw new LibraryError("Collection name is required.");
    const state = await loadState(library);
    const now = new Date().toISOString();
    const collection = {
      id: state.nextCollectionId,
      name,
      paths: cleanPaths(body?.paths),
      createdAt: now,
      updatedAt: now,
    };
    state.nextCollectionId += 1;
    state.collections.push(collection);
    await saveState(library);
    return { collection };
  });
}

export function updateCollection(library, id, body) {
  return locked(library, async () => {
    const state = await loadState(library);
    const collection = state.collections.find((entry) => entry.id === id);
    if (!collection) throw new LibraryError("Collection not found.", 404);
    if (Object.hasOwn(body, "name")) {
      const name = cleanText(body.name, 120);
      if (!name) throw new LibraryError("Collection name is required.");
      collection.name = name;
    }
    if (Object.hasOwn(body, "paths")) collection.paths = cleanPaths(body.paths);
    if (Array.isArray(body.add))
      collection.paths = cleanPaths([...collection.paths, ...body.add]);
    if (Array.isArray(body.remove)) {
      const gone = new Set(body.remove.map(cleanRelativePath));
      collection.paths = collection.paths.filter((entry) => !gone.has(entry));
    }
    collection.updatedAt = new Date().toISOString();
    await saveState(library);
    return { collection };
  });
}

export function deleteCollection(library, id) {
  return locked(library, async () => {
    const state = await loadState(library);
    const index = state.collections.findIndex((entry) => entry.id === id);
    if (index < 0) throw new LibraryError("Collection not found.", 404);
    const [deleted] = state.collections.splice(index, 1);
    await saveState(library);
    return { deleted };
  });
}
