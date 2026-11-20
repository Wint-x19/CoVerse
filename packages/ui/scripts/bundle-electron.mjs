import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");

await Promise.all([
  build({
    entryPoints: [path.join(root, "src/main/index.ts")],
    outfile: path.join(root, "dist/main/index.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: true,
    external: ["electron", "sql.js"],
    banner: {
      js: 'import { createRequire as __coverseCreateRequire } from "node:module"; const require = __coverseCreateRequire(import.meta.url);',
    },
  }),
  build({
    entryPoints: [path.join(root, "src/preload/index.ts")],
    outfile: path.join(root, "dist/preload/index.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    sourcemap: true,
    external: ["electron"],
  }),
]);
