const PASSTHROUGH_ENV_KEYS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TERM',
  'NO_COLOR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const

/** Build the minimal environment inherited by the official Claude Code subprocess. */
export function buildClaudeSdkEnvironment(input: NodeJS.ProcessEnv, configDirectory: string, model?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = optionalEnvironmentValue(input, key)
    if (value !== undefined) env[key] = value
  }

  const bridgeBaseURL = optionalEnvironmentValue(input, 'FREECODEGO_CLAUDE_BASE_URL')
  const bridgeApiKey = optionalEnvironmentValue(input, 'FREECODEGO_CLAUDE_API_KEY')
  const bridgeToken = bridgeApiKey ?? optionalEnvironmentValue(input, 'FREECODEGO_CLAUDE_AUTH_TOKEN')
  if (bridgeBaseURL !== undefined) {
    if (bridgeToken === undefined) throw new Error('FreeCodeGo Claude gateway is missing its short-lived token')
    env.ANTHROPIC_BASE_URL = normalizeAnthropicBaseURL(bridgeBaseURL)
    // An API key tells Claude Code that this plugin-owned local facade is its
    // credential source, preventing the interactive `/login` prerequisite.
    env.ANTHROPIC_API_KEY = bridgeToken
  } else {
    const configuredBaseURL = optionalEnvironmentValue(input, 'ANTHROPIC_BASE_URL')
    const configuredToken = optionalEnvironmentValue(input, 'ANTHROPIC_AUTH_TOKEN')
    const configuredAPIKey = optionalEnvironmentValue(input, 'ANTHROPIC_API_KEY')
    if (configuredBaseURL !== undefined) env.ANTHROPIC_BASE_URL = normalizeAnthropicBaseURL(configuredBaseURL)
    if (configuredToken !== undefined) env.ANTHROPIC_AUTH_TOKEN = configuredToken
    if (configuredAPIKey !== undefined) env.ANTHROPIC_API_KEY = configuredAPIKey
    if (configuredBaseURL !== undefined && configuredToken === undefined && configuredAPIKey === undefined) {
      throw new Error('Anthropic-compatible gateway is missing ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY')
    }
  }

  env.CLAUDE_CONFIG_DIR = configDirectory
  env.CLAUDE_CODE_SIMPLE = '1'
  const selectedModel = model?.trim()
  if (selectedModel !== undefined && selectedModel !== '') env.ANTHROPIC_MODEL = selectedModel
  env.DISABLE_AUTOUPDATER = '1'
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  return env
}

function optionalEnvironmentValue(input: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = input[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

function normalizeAnthropicBaseURL(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Claude gateway base URL must be an absolute HTTP URL')
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Claude gateway base URL must use HTTPS unless it targets localhost')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('Claude gateway base URL must not contain credentials, query, or fragment')
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '') || '/'
  return url.toString().replace(/\/$/, '')
}
