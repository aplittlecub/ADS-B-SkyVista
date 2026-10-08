import { defineConfig } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export default defineConfig(({ mode }) => ({
  plugins: mode === "verify" ? [] : [
    {
      name: "sync-card-package",
      async writeBundle(output) {
        // Runs after each completed build, including build:watch.
        for (const name of ["flight-card.js", "flight-card.js.map"]) {
          // Plain writes also work across Docker Desktop's Windows bind mounts.
          await writeFile(
            resolve("custom_components/flight_card", name),
            await readFile(resolve(output.dir!, name)),
          );
        }
      },
    },
  ],
  build: {
    target: "es2022",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
    lib: {
      entry: "src/flight-card.ts",
      formats: ["es"],
      fileName: () => "flight-card.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        // Stable paths even when verification builds into a temporary directory.
        sourcemapPathTransform: (source, mapPath) =>
          `../${relative(process.cwd(), resolve(dirname(mapPath), source)).replace(/\\/g, "/")}`,
      },
    },
  },
}));
