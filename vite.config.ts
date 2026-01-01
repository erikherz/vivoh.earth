import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyDirBeforeWrite: true,
  },
  server: {
    port: 3000,
  },
});
