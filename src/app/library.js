export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatShape(video) {
  return video.width && video.height ? `${video.width}x${video.height}` : "";
}

export function progressFraction(video) {
  if (!video.duration || !video.position) return 0;
  return Math.min(1, Math.max(0, video.position / video.duration));
}

const START_SECONDS = 15;
const END_SECONDS = 15;

export function isStarted(video) {
  const duration = video.duration || 0;
  return (
    video.position >
    (duration ? Math.min(START_SECONDS, duration * 0.02) : START_SECONDS)
  );
}

export function isNearEnd(video) {
  const duration = video.duration || 0;
  if (!duration) return false;
  return video.position > duration - Math.min(END_SECONDS, duration * 0.05);
}

export function resumeTime(video, duration) {
  const total = duration || video.duration || 0;
  if (!video.position || video.watched) return 0;
  const floor = total ? Math.min(5, total * 0.01) : 5;
  const ceiling = total
    ? total - Math.min(END_SECONDS, total * 0.05)
    : Number.POSITIVE_INFINITY;
  return video.position > floor && video.position < ceiling
    ? video.position
    : 0;
}

export function continueWatching(videos) {
  return videos
    .filter((video) => !video.watched && isStarted(video) && !isNearEnd(video))
    .sort((a, b) =>
      String(b.playedAt || "").localeCompare(String(a.playedAt || "")),
    );
}

export function foldersFor(videos) {
  const folders = new Map();
  for (const video of videos) {
    const key = video.folder || "";
    const entry = folders.get(key) || {
      key,
      name: key ? key.split("/").at(-1) : "Loose files",
      videos: [],
      size: 0,
    };
    entry.videos.push(video);
    entry.size += video.size;
    folders.set(key, entry);
  }
  return [...folders.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function tagsFor(videos) {
  const counts = new Map();
  for (const video of videos)
    for (const tag of video.tags) counts.set(tag, (counts.get(tag) || 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export function videoMatches(video, query) {
  const text = query.trim().toLowerCase();
  if (!text) return true;
  return [
    video.title,
    video.name,
    video.folder,
    video.description,
    video.tags.join(" "),
  ]
    .join(" ")
    .toLowerCase()
    .includes(text);
}

export function subtitleFor(video) {
  return [
    video.folder,
    formatDuration(video.duration),
    formatShape(video),
    formatBytes(video.size),
  ]
    .filter(Boolean)
    .join(" / ");
}
