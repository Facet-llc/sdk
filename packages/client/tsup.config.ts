import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "es2022",
  treeshake: true,
  // `@facet-llc/adapter` is a runtime peer — ships alongside as a separate
  // package on npm, so tsup must not bundle its source into client's
  // dist/index.js.
  external: ["@facet-llc/adapter"],
});
