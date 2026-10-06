export function pathWithSearchParams(path, updates = {}) {
  const url = new URL(path || "/", "http://localhost");
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
