/** Root-relative doc paths and the viewer URLs that carry them. */

export function encodePath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

export function relFromPathname(pathname) {
  try {
    return pathname.replace(/^\/view\/?/, "").split("/").map(decodeURIComponent).join("/");
  } catch {
    return "";
  }
}

/** The stored version a URL asks for (?v=3), or null for the file as it is now. */
export function versionFromSearch(search) {
  return Number(new URLSearchParams(search).get("v")) || null;
}
