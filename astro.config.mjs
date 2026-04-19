import { defineConfig } from "astro/config";
import tailwind from "@astrojs/tailwind";
import mdx from "@astrojs/mdx";

// https://astro.build/config
// NOTE: @astrojs/sitemap temporarily disabled — incompatible with astro@3.6.5
// (template shipped with mismatched versions). Re-enable after upgrading Astro.
export default defineConfig({
  site: "https://www.posicionamiento-web-salamanca.com",
  integrations: [tailwind(), mdx()],
});
