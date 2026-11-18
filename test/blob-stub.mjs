// In-memory stand-in for @vercel/blob so the tests run without a Vercel token.
globalThis.__blobs ??= [];
let n = 0;
export async function put(path, body) {
  if (globalThis.__blobBlocked) throw new Error("Vercel Blob: Your store is blocked");
  const url = `https://blob.test/${path}`;
  globalThis.__blobs.push({ pathname: path, url, body, uploadedAt: new Date(Date.now() + n++).toISOString() });
  return { url, pathname: path };
}
export async function list({ prefix = "" } = {}) {
  return { blobs: globalThis.__blobs.filter((b) => b.pathname.startsWith(prefix)) };
}
export async function del(urls) {
  const set = new Set([].concat(urls));
  globalThis.__blobs = globalThis.__blobs.filter((b) => !set.has(b.url));
}
