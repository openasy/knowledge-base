import { defineConfig } from "vite";

// suggest.js, small and with no dependencies: the server adds the knowledge base's settings and calls OAKB.start().
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: "../dist/suggest",
    emptyOutDir: true,
    target: "es2019",
    lib: { entry: "suggest.ts", formats: ["iife"], name: "OAKB", fileName: () => "suggest.js" },
  },
});
