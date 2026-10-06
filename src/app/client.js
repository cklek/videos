async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error)
    throw new Error(body?.error || `Request failed (${response.status})`);
  return body;
}

const asJson = (body) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export function fetchLibrary() {
  return request("/api/library");
}

export function rescanLibrary(force = false) {
  return request(`/api/rescan${force ? "?force=1" : ""}`, { method: "POST" });
}

export function fetchSubtitles(path) {
  return request(`/api/subtitles?path=${encodeURIComponent(path)}`);
}

export function setFavorite(path, favorite) {
  return request("/api/favorite", asJson({ path, favorite }));
}

export function updateVideo(path, patch) {
  return request("/api/video", {
    ...asJson({ path, ...patch }),
    method: "PATCH",
  });
}

export function trashVideos(paths) {
  const query = paths
    .map((path) => `path=${encodeURIComponent(path)}`)
    .join("&");
  return request(`/api/video?${query}`, { method: "DELETE" });
}

export function restoreTrash(batchId) {
  return request("/api/trash", asJson({ batchId }));
}

export function emptyTrash() {
  return request("/api/trash", { method: "DELETE" });
}

export function createCollection(name, paths = []) {
  return request("/api/collections", asJson({ name, paths }));
}

export function updateCollection(id, patch) {
  return request(`/api/collections/${id}`, {
    ...asJson(patch),
    method: "PATCH",
  });
}

export function deleteCollection(id) {
  return request(`/api/collections/${id}`, { method: "DELETE" });
}

export function uploadFiles(files) {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  return request("/api/upload", { method: "POST", body: form });
}

export async function reportProgress(path, patch, { beacon = false } = {}) {
  const body = JSON.stringify({ path, ...patch });
  if (beacon && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(
      "/api/progress",
      new Blob([body], { type: "application/json" }),
    );
    return Promise.resolve(null);
  }
  return fetch("/api/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => null);
}

export async function uploadPoster(path, blob) {
  return fetch(`/api/poster?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: blob,
  }).catch(() => null);
}
