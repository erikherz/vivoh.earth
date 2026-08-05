import { resolve } from "path";
export default {
  build: { rollupOptions: { input: { publish: resolve(__dirname,"publish.html"), watch: resolve(__dirname,"watch.html") } } },
  server: { port: 5273 },
};
