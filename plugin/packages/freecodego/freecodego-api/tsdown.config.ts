import { defineConfig } from 'tsdown'

/**
 * Build the Host-only API client independently of unrelated workspace bundles.
 *
 * `fixedExtension` is stated once, as `false`: this package's manifest resolves
 * to `lib/index.js`. A second `fixedExtension: true` used to sit above it, where
 * it was silently overridden by this one — leaving two answers to the same
 * question in the file, and the losing answer looking authoritative.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
