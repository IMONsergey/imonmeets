import { access } from "node:fs/promises";

// Production images contain dist; development checkouts use the same source
// through their pinned tsx loader. No parallel mail transport is maintained.
export async function apiRuntime(name) {
  if (!/^[a-z-]+$/.test(name)) throw new Error("INVALID_API_MODULE");
  const built = new URL(`../apps/api/dist/${name}.js`, import.meta.url);
  try { await access(built); } catch {
    const { register } = await import("tsx/esm/api");
    register();
    return import(new URL(`../apps/api/src/${name}.ts`, import.meta.url).href);
  }
  return import(built.href);
}
