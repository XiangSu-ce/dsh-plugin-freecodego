import { defineConfig } from 'tsdown'
/** Build the private Host package. Typert contracts are generated explicitly
 * by `scripts/generate-typert.mjs` before bundling to keep release analysis
 * isolated from tsdown's workspace-wide symbol graph. */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [],
})
