/**
 * Explain a publish the registry refused for want of credentials.
 *
 * npm authenticates this workflow with an OIDC token that the registry
 * exchanges for a short-lived publish token, and every way that exchange can
 * fail is silent: npm prints its own reason at verbose level only, so a job
 * without `id-token: write`, a trusted publisher naming another repository or
 * workflow file, and a connection that allows staged publishes only all surface
 * as the same `ENEEDAUTH`. Nothing here can see the npmjs.com side, so the hint
 * states what this run does know and names the settings that would have to
 * differ, which is what turns one blind CI round into a readable failure.
 */

/** Environment variables GitHub Actions sets for a job allowed to request an OIDC token. */
const OIDC_REQUEST_URL = 'ACTIONS_ID_TOKEN_REQUEST_URL'
const OIDC_REQUEST_TOKEN = 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'

/** Where a trusted publisher connection is configured, named as the reader will look for it. */
const SETTINGS_LOCATION = 'npmjs.com -> the package -> Settings -> Trusted publishing'

/** What a refused publish can observe about itself. */
export interface AuthDiagnosisInput {
  /** Combined stdout and stderr of the `npm publish` that failed. */
  readonly output: string
  /** Environment the publish ran in. */
  readonly environment: NodeJS.ProcessEnv
  /** Manifest of the tarball being published, when it has been read. */
  readonly manifest?: Record<string, unknown> | undefined
}

/**
 * Whether a failure is the registry saying it saw no credentials at all.
 * @param output - combined npm output.
 * @returns True when npm refused before authenticating.
 */
function isCredentialless(output: string): boolean {
  return output.includes('ENEEDAUTH') || output.includes('need auth')
}

/**
 * The `owner/repo` a repository URL names, when it names a GitHub repository.
 *
 * `repository.url` is conventionally written `git+https://github.com/o/r.git`,
 * so the scheme prefix, a trailing `.git`, a narrowing fragment and a trailing
 * slash all have to come off before it can be compared with `GITHUB_REPOSITORY`.
 * @param url - a `repository.url` value.
 * @returns Lower-cased `owner/repo`, or undefined for anything else.
 */
function repositorySlug(url: string): string | undefined {
  const peeled = url.split('#')[0]?.replace(/\/+$/u, '').replace(/\.git$/u, '') ?? ''
  const match = /github\.com[/:]([^/]+)\/(.+)$/u.exec(peeled)
  if (match?.[1] === undefined || match[2] === undefined) return undefined
  return `${match[1]}/${match[2]}`.toLowerCase()
}

/**
 * The repository URL a packed manifest declares.
 * @param manifest - a packed tarball's package.json.
 * @returns The URL, whether it is written as a string or as an object.
 */
function repositoryUrlOf(manifest: Record<string, unknown> | undefined): string | undefined {
  const repository = manifest?.['repository']
  if (typeof repository === 'string') return repository
  if (repository === null || typeof repository !== 'object' || Array.isArray(repository)) return undefined
  const url = (repository as Record<string, unknown>)['url']
  return typeof url === 'string' ? url : undefined
}

/**
 * The workflow filename inside a `GITHUB_WORKFLOW_REF` value.
 *
 * The value is a path with a ref after an `@`, for example
 * `owner/repo/.github/workflows/release.yml@refs/tags/v1`, and the trusted
 * publisher expects the filename alone — not the path, and not the ref.
 * @param reference - the `GITHUB_WORKFLOW_REF` value, when the run has one.
 * @returns A filename such as `release.yml`.
 */
function workflowFilenameOf(reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined
  const marker = '.github/workflows/'
  const index = reference.lastIndexOf(marker)
  if (index === -1) return undefined
  const tail = reference.slice(index + marker.length)
  const at = tail.indexOf('@')
  return at === -1 ? tail : tail.slice(0, at)
}

/**
 * The lines that explain a credential-less publish, or nothing for another failure.
 * @param input - the failed command's output and the environment it ran in.
 * @returns A hint to append to the thrown error, or undefined when the failure is unrelated.
 */
export function registryAuthHint(input: AuthDiagnosisInput): string | undefined {
  if (!isCredentialless(input.output)) return undefined

  const environment = input.environment
  const isSet = (name: string): boolean => (environment[name] ?? '') !== ''
  const lines = [
    '',
    'The registry refused this publish for want of credentials. npm authenticates',
    'trusted publishing with an OIDC token, so this is one of three settings — and',
    'npm prints which at verbose level only (`NPM_CONFIG_LOGLEVEL=silly`).',
    '',
  ]

  if (!isSet(OIDC_REQUEST_URL) || !isSet(OIDC_REQUEST_TOKEN)) {
    lines.push(
      `  No OIDC token reached npm: ${OIDC_REQUEST_URL} and`,
      `  ${OIDC_REQUEST_TOKEN} are not both set, and npm attempts the`,
      '  exchange only when they are. GitHub Actions sets them for a job that',
      '  declares `permissions: id-token: write` — the permission belongs on the',
      '  job running this step, not on the workflow, and not on a sibling job.',
      '',
    )
  } else {
    const repository = environment['GITHUB_REPOSITORY'] ?? ''
    const [owner, name] = repository.split('/')
    lines.push(
      '  The OIDC token was available, so the registry refused the exchange. The',
      `  package needs a trusted publisher (${SETTINGS_LOCATION})`,
      '  naming this run exactly:',
      '',
      `    Organization or user: ${owner === undefined || owner === '' ? '<owner>' : owner}`,
      `    Repository:           ${name === undefined || name === '' ? '<repo>' : name}`,
      `    Workflow filename:    ${workflowFilenameOf(environment['GITHUB_WORKFLOW_REF']) ?? '<workflow>.yml'}`,
      '    Environment name:     empty, unless this job declares one',
      '',
      '  Every field is case sensitive, and a connection created after 2026-09-03',
      '  allows `npm stage publish` only: `npm publish` has to be added to its',
      '  allowed actions as well.',
      '',
    )
  }

  const declared = repositoryUrlOf(input.manifest)
  const expected = environment['GITHUB_REPOSITORY']
  if (declared !== undefined && expected !== undefined) {
    const failing = repositorySlug(declared) !== undefined && repositorySlug(declared) !== expected.toLowerCase()
    lines.push(
      failing
        ? `  The packed manifest declares repository.url ${declared}, which is not`
          + `\n  ${expected}: trusted publishing matches that field against the repository the`
          + '\n  workflow runs in, so a fork that keeps the upstream URL cannot publish this way.'
        : `  The packed manifest's repository.url agrees with ${expected}, so that field is not the cause.`,
      '',
    )
  }

  return lines.join('\n')
}
