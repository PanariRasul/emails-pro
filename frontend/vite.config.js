import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Local development mirrors production's same-origin /api rewrite.
    proxy: {
      "/api": { target: "http://localhost:10000", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2020",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (
            /recharts|d3-|victory-vendor|decimal\.js|redux|immer|reselect/.test(
              id,
            )
          )
            return "charts";
          // Editor packages first: "@tiptap/react/" would otherwise match the React rule below and create a circular chunk.
          if (
            /@tiptap|prosemirror|linkifyjs|orderedmap|rope-sequence|w3c-keyname/.test(
              id,
            )
          )
            return "editor";
          if (/react-dom|scheduler|react-router|[\\/]react[\\/]/.test(id))
            return "react";
          if (/@tanstack|zustand/.test(id)) return "query";
          return undefined;
        },
      },
    },
  },
});
