import { defineConfig } from 'tsdown'
export default defineConfig({ entry: ['lib/types/index.js', 'lib/types/worker.js'], outDir: 'lib', format: ['esm'], fixedExtension: true, platform: 'node', target: 'es2024', dts: false, clean: false })
