import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  // public/probe.html is copied verbatim, never bundled. That is deliberate:
  // the Phase 0 probe has to still load when the app's own bundle is broken,
  // since "is the bundle broken in this browser" is one of the things it tests.
});
