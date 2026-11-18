// In-memory stand-in for @vercel/blob so the tests run without a Vercel token.
globalThis.__blobs ??= [];
let n = 0;
export async function put(path, body) {
  if (globalThis.__blobBlocked) throw new Error("Vercel Blob: Your store is blocked");
  const url = `https://teststore.public.blob.vercel-storage.com/${path}`;
  globalThis.__blobs = globalThis.__blobs.filter((b) => b.pathname !== path); // overwrite
  globalThis.__blobs.push({ pathname: path, url, body, uploadedAt: new Date(Date.now() + n++).toISOString() });
  return { url, pathname: path };
}
export async function list({ prefix = "" } = {}) {
  globalThis.__listCalls = (globalThis.__listCalls ?? 0) + 1;
  return { blobs: globalThis.__blobs.filter((b) => b.pathname.startsWith(prefix)) };
}
export async function del(urls) {
  const set = new Set([].concat(urls));
  globalThis.__blobs = globalThis.__blobs.filter((b) => !set.has(b.url));
}
