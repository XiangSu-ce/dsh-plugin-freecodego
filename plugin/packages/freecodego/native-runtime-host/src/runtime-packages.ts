import type { NativeRuntimePlatform } from './manifest.ts'
import type { RuntimeDownloadSpec } from './runtime-download.ts'

const CODEX_VERSION = '0.147.0'
const CLAUDE_SDK_VERSION = '0.3.246'

const codexIntegrity: Readonly<Record<NativeRuntimePlatform, string>> = {
  'win32-x64': 'sha512-oT7Ss5fAPf2fiWE9QNURqZcQGAAawSVxmIUdgPzckq4KFZAM+pRz9JbM4Rr498CjtbNgTOjWvDJ+DXvIBSfOPA==',
  'win32-arm64': 'sha512-e2ZstJ8zT8Rm1nvR7CUVO+Gr3cTChE41+VfOzGhynzDXEoW0wfbjUQbc2bWbh1arG94LMm4y3dqBtUIbSrfeGA==',
  'linux-x64': 'sha512-0W9MBxPpWW0cSkNqrTDN2jR7rzzT7oNMhQY5446lT2Lw5cz5yhDTck4Va9rjkQEm+HlFzP/dmEMSZbXfJsINmw==',
  'linux-arm64': 'sha512-SLC1JXw2TYfr/c3HhrJubyyLelq7vTOLWVmiThFA+z0+WgzCPmaseJ/kzDD3Gge/TO7fCnnj7UcPmC0d2c8XAg==',
  'darwin-x64': 'sha512-Tb8McE5SvJIH0Vs5R6sq7u+quiC931yan2KOOl6km1OdZ82+Wi7eF5XrSFPs5CF7xCgoIK4Vs+byMbT5hN+ZUw==',
  'darwin-arm64': 'sha512-BEUVkiOW7kLcRyrMLfAr/h9wF8sRVJyZDy6OHtVn6QGDXiv3BvAZVTY1Pu9xF7KdIdkYXbp4uayN0aDQQaAUJw==',
}

const claudeIntegrity: Readonly<Record<NativeRuntimePlatform, string>> = {
  'win32-x64': 'sha512-omI65bYGynLpE1Ybijk56K1wBnt0H6WujNwlg1LzIdeHrYmpUxoqncK92xKH5kb9XWUz3byHqArbv7wsT+M/2A==',
  'win32-arm64': 'sha512-JV8b28OJ8d+EMVEVIWlN3aEkT8uSehO3ZN/PJzXFG7Jgn56oVYUew4aY9vK4jao/4E4mdfzvs358w4HcTBUzVw==',
  'linux-x64': 'sha512-BIbBlJ6x7Cys6UFvahUfce26H+U+Q4tLWjKRD39AaV7JvRav8/vfdFytzWq6E+h9hT1OOWYuPYx2gMn5vDhZhQ==',
  'linux-arm64': 'sha512-t7AEewD7bcjZYMmrfFLjsUSxPo4z+5J5O5cC9V2zOvAhNkefdMeGWI2/1cdqZxuaOiFVt46byjlZuiNNunF+bQ==',
  'darwin-x64': 'sha512-yl+gMMFUQ8++SBaxUe2JxBqU0LOJO4HZTsWWTOrH5kRlTRhdQDF/lESsoNXCHgfF/+77YNKgef0h+rl/D12Jfg==',
  'darwin-arm64': 'sha512-pYDv2RT+UVOvEapMEWKf7Gm5a87Si1Zf+XR23IMGYbG5mESatNJ8Gz2PmkrwfTezZknb0ljWZe8zgcTFITM3dA==',
}

const platforms = Object.keys(codexIntegrity) as NativeRuntimePlatform[]

/**
 * Official Codex runtime packages, one per published platform.
 */
export const codexRuntimePackages: readonly RuntimeDownloadSpec[] = platforms.map(platform => ({
  id: `codex:${platform}:${CODEX_VERSION}`,
  engine: 'codex',
  platform,
  label: `Codex ${CODEX_VERSION} (${platform})`,
  version: CODEX_VERSION,
  runtimeVersion: `codex/${CODEX_VERSION}`,
  sourceRevision: `npm:@openai/codex@${CODEX_VERSION}-${platform}`,
  downloadURL: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-${platform}.tgz`,
  integrity: codexIntegrity[platform],
  maxArchiveBytes: 512 * 1024 * 1024,
}))

/**
 * Official Claude Agent SDK runtime packages, one per published platform.
 */
export const claudeRuntimePackages: readonly RuntimeDownloadSpec[] = platforms.map(platform => ({
  id: `claude:${platform}:${CLAUDE_SDK_VERSION}`,
  engine: 'claude',
  platform,
  label: `Claude Agent SDK ${CLAUDE_SDK_VERSION} (${platform})`,
  version: CLAUDE_SDK_VERSION,
  runtimeVersion: `claude-agent-sdk-worker/${CLAUDE_SDK_VERSION}`,
  sourceRevision: `npm:@anthropic-ai/claude-agent-sdk-${platform}@${CLAUDE_SDK_VERSION}`,
  downloadURL: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-${platform}/-/claude-agent-sdk-${platform}-${CLAUDE_SDK_VERSION}.tgz`,
  integrity: claudeIntegrity[platform],
  maxArchiveBytes: 384 * 1024 * 1024,
}))
