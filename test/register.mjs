// node --import ./test/register.mjs <test>: swaps @vercel/blob for the in-memory stub.
import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec === "@vercel/blob") return { url: ${JSON.stringify(new URL("./blob-stub.mjs", import.meta.url).href)}, shortCircuit: true };
    return next(spec, ctx);
  }`));
