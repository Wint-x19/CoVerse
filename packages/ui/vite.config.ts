import path from "node:path";
import fs from "node:fs/promises";
import {createRequire} from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  base: "./",
  plugins: [react(), tailwindcss(), {
    name: "pdf-preview-resources",
    apply: "build",
    async buildStart() {
      const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
      for (const folder of ["cmaps","standard_fonts","wasm"]) {
        for (const entry of await fs.readdir(path.join(root,folder))) {
          this.emitFile({type:"asset",fileName:"pdf-resources/" + folder + "/" + entry,source:await fs.readFile(path.join(root,folder,entry))});
        }
      }
    },
  }],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/client"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
