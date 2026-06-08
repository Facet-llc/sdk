import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  treeshake: true,
  // Workspace peers — ship alongside on npm, never bundle their sources
  // into sdk-node's dist/index.js. Mirrors packages/client/tsup.config.ts.
  external: ["@facet-llc/protocol", "@facet-llc/client"],
});
