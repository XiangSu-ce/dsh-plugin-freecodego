import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../../../..')
const packageName = '@deepseek-ai/dsh-freecodego-harness-plugin'
const configName = '.freecodego-typert.host.json'
const configFile = resolve(root, configName)
const hostConfig = await readFile(resolve(root, 'tsconfig.host.json'), 'utf8')
const injected = hostConfig.replace(/"references"\s*:\s*\[/u, '$&\n    { "path": "./packages/freecodego/harness-plugin" },')
if (injected === hostConfig) throw new Error('could not inject the FreeCodeGo Typert project reference')

await writeFile(configFile, injected)
try {
  const generator = resolve(root, 'packages/typert/generator/lib/types')
  const { WorkspaceAnalyzer } = await import(pathToFileURL(resolve(generator, 'analyzer.js')).href)
  const { FaceModelEmitter } = await import(pathToFileURL(resolve(generator, 'emitter.js')).href)
  const workspace = new WorkspaceAnalyzer({
    root,
    hostConfig: configName,
    clientConfig: '.freecodego-typert.client.absent.json',
    packages: [packageName],
    faces: ['host'],
    checkDiagnostics: false,
  }).analyze()
  const face = workspace.faces.find(value => value.face === 'host')
  if (face === undefined) throw new Error('FreeCodeGo Host Typert model was not generated')
  const artifact = new FaceModelEmitter(face).emit(packageName)
  if (artifact.remote === undefined) throw new Error('FreeCodeGo Host Remote contract was not generated')
  const output = resolve(import.meta.dirname, '..', 'lib')
  await mkdir(output, { recursive: true })
  await Promise.all([
    writeFile(resolve(output, 'typert.host.js'), artifact.js),
    writeFile(resolve(output, 'typert.host.d.ts'), artifact.dts),
    writeFile(resolve(output, 'typert.remote-client.js'), artifact.remote.js),
    writeFile(resolve(output, 'typert.remote-client.d.ts'), artifact.remote.dts),
    writeFile(resolve(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap),
  ])
} finally {
  await rm(configFile, { force: true })
}
