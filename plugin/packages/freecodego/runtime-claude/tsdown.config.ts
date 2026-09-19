import { defineConfig } from 'tsdown'
// One entry: the SDK session runs in the Host process. The sidecar worker entry
// that used to be built here was never spawned — see the header of src/index.ts.
export default defineConfig({ entry: ['src/index.ts'], outDir: 'lib', format: ['esm'], fixedExtension: true, dts: true, clean: false })
