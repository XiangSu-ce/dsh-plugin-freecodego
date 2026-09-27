/**
 * An MCP marketplace entry whose argv is an installation step, not a server.
 *
 * `marketplaceMcpDefinition` is the one place a community directory's published
 * `config` becomes an installable server, and that config is untrusted
 * third-party data the directory does not schema-check. What is only true of
 * this path, and what each case here exists to hold, is the boundary:
 *
 * 1. **The live payload is refused.** mcp.so's `context7-mcp` publishes
 *    `{"command":"npx","args":["ctx7","setup"]}`, and `ctx7 setup` is Context7's
 *    OAuth installer ("Set up Context7 MCP for your coding agents"), not its
 *    server. Installed verbatim it spawns a process that authenticates in a
 *    browser and then never answers the JSON-RPC handshake. Refused means
 *    `undefined`, which `mcpPresetInstall` already renders as "add it by hand".
 * 2. **The server that payload documents stays importable.** A refusal must not
 *    cost the entry its real stdio package or its HTTP URL — those are exactly
 *    what a user should install instead.
 * 3. **The guard reads verbs, not substrings.** A directory named `install` or a
 *    path segment `setup` is a value, not an installation step, and refusing one
 *    would break a working server.
 *
 * Every case is offline: the payloads are literals, not fetches.
 */

import { describe, expect, it } from 'vitest'

import { marketplaceMcpDefinition, marketplaceMcpName, mcpCommandLooksLikeInstaller } from '../src/marketplace-utils.ts'

/** The `config` field mcp.so serves for `context7-mcp`, byte for byte. */
const CONTEXT7_LIVE_CONFIG = '{"mcpServers":{"context7-mcp":{"command":"npx","args":["ctx7","setup"]}}}'

/** Build a detail record around one `mcpServers` entry, as the directory serves it. */
function detail(entry: Record<string, unknown>): Record<string, unknown> {
  return { config: JSON.stringify({ mcpServers: { 'some-server': entry } }) }
}

describe('marketplace MCP definition', () => {
  it('refuses the installer argv mcp.so publishes for context7-mcp', () => {
    expect(marketplaceMcpDefinition('context7-mcp', { config: CONTEXT7_LIVE_CONFIG })).toBeUndefined()
  })

  it('still imports the server the same payload documents', () => {
    // The stdio package Context7's own README names, and the URL it offers as
    // the alternative. Refusing the installer must not refuse either.
    expect(marketplaceMcpDefinition('context7-mcp', detail({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] })))
      .toEqual({
        enabled: true,
        transport: 'stdio',
        serverName: marketplaceMcpName('context7-mcp'),
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        env: {},
        cwd: '',
        url: '',
        headers: {},
      })
    expect(marketplaceMcpDefinition('context7-mcp', detail({ url: 'https://mcp.context7.com/mcp' })))
      .toEqual({
        enabled: true,
        transport: 'streamable-http',
        serverName: marketplaceMcpName('context7-mcp'),
        command: '',
        args: [],
        env: {},
        cwd: '',
        url: 'https://mcp.context7.com/mcp',
        headers: {},
      })
  })

  it('reads an installation step in either spelling', () => {
    for (const argument of ['setup', '--setup', 'install', '--install', 'init', 'configure', 'login', 'auth', 'remove', 'uninstall']) {
      expect(marketplaceMcpDefinition('some-server', detail({ command: 'npx', args: ['pkg', argument] }))).toBeUndefined()
    }
  })

  it('does not mistake a value for a verb', () => {
    // Each of these is a working server whose argv merely *contains* one of the
    // verbs. Whole-token comparison is what keeps the guard from being wider
    // than the thing it guards.
    const kept: readonly (readonly string[])[] = [
      ['-y', '@modelcontextprotocol/server-filesystem', '/srv/install'],
      ['/opt/setup/server.js'],
      ['-y', 'mcp-server-fetch', '--auth-token', 'placeholder'],
      ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      [],
    ]
    for (const args of kept) {
      const definition = marketplaceMcpDefinition('some-server', detail({ command: 'npx', args }))
      expect(definition, `args ${JSON.stringify(args)} must stay importable`).toBeDefined()
      expect(definition?.args).toEqual(args)
    }
  })

  it('judges arguments only, never the executable', () => {
    // argv[0] is the program being run. Treating it as a verb would refuse a
    // server the moment somebody shipped a binary with one of these names.
    expect(mcpCommandLooksLikeInstaller(['npx'])).toBe(false)
    expect(mcpCommandLooksLikeInstaller(['setup'])).toBe(false)
    expect(mcpCommandLooksLikeInstaller(['npx', 'ctx7', 'setup'])).toBe(true)
  })

  it('keeps refusing a payload with no transport at all', () => {
    expect(marketplaceMcpDefinition('some-server', detail({}))).toBeUndefined()
    expect(marketplaceMcpDefinition('some-server', detail({ command: '   ' }))).toBeUndefined()
  })
})
