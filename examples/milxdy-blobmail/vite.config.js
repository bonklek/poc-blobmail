import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL("./src/content.js", import.meta.url)),
      formats: ["es"],
      fileName: () => "content.js",
    },
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
  resolve: {
    preserveSymlinks: false,
  },
  root: packageRoot,
});
