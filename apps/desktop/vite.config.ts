import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // The production renderer is loaded from Electron with file://. Relative
  // asset URLs are required there; absolute /assets URLs resolve to the host
  // filesystem root and leave the packaged window blank.
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
