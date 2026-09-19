import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { stableJson } from '../src/stable-json.ts'
import { bashCredentialDenial, credentialReadDenial, credentialRealpathDenial, DoomLoopGuard, isCredentialPath } from '../src/tool-guards.ts'

describe('credential read guard', () => {
  it('flags env, key, and secret-store paths', () => {
    expect(isCredentialPath('.env')).toBe(true)
    expect(isCredentialPath('/work/project/.env.local')).toBe(true)
    expect(isCredentialPath('/work/project/.env')).toBe(true)
    expect(isCredentialPath('/work/project/.npmrc')).toBe(true)
    expect(isCredentialPath('/work/project/.git-credentials')).toBe(true)
    expect(isCredentialPath('/work/project/secrets.json')).toBe(true)
    expect(isCredentialPath('/work/project/server.pem')).toBe(true)
    expect(isCredentialPath('/work/project/id_ed25519')).toBe(true)
    expect(isCredentialPath('/home/u/.ssh/known_hosts')).toBe(true)
    expect(isCredentialPath('/home/u/.aws/credentials')).toBe(true)
    expect(isCredentialPath('/home/u/.aws/config')).toBe(false)
    // Examples are safe to read.
    expect(isCredentialPath('/work/project/.env.example')).toBe(false)
    expect(isCredentialPath('/work/project/.env.sample')).toBe(false)
    expect(isCredentialPath('/work/project/src/env.ts')).toBe(false)
    expect(isCredentialPath('/work/project/README.md')).toBe(false)
  })

  it('knows the credential store of every provider, not only the one that was written first', () => {
    // The same defect the tool list above records, one list over: the vocabulary
    // held `~/.aws/credentials` and none of the stores beside it. Measured before
    // these entries existed, every path in the first loop below was readable while
    // `.aws/credentials` was refused — the plugin's own users sign in to these four
    // providers from a session, and each file carries a token, a client key or a
    // registry password in cleartext.
    for (const path of [
      '/home/u/.kube/config',
      'C:\\Users\\u\\.kube\\config',
      '/home/u/.docker/config.json',
      '/home/u/.config/gh/hosts.yml',
      '/home/u/.config/gcloud/application_default_credentials.json',
      '/home/u/.azure/msal_token_cache.json',
    ]) expect(isCredentialPath(path), path).toBe(true)
    // The shell tier reaches the same vocabulary, so the denial is not a path-tool
    // -only property.
    expect(bashCredentialDenial('cat ~/.kube/config')).toContain('credential guard')
    // The other spellings of a private key, one family rather than three arms.
    expect(isCredentialPath('/home/u/.ssh/id_ed25519_sk')).toBe(true)
    expect(isCredentialPath('/work/keys/id_ecdsa_sk')).toBe(true)
    expect(isCredentialPath('/work/project/.envrc')).toBe(true)
    // The neighbouring non-secret files stay readable, and so does a same-named
    // file outside the directory that names it — the folder is not the secret.
    expect(isCredentialPath('/home/u/.config/gh/config.yml')).toBe(false)
    expect(isCredentialPath('/home/u/.docker/contexts/meta/abc.json')).toBe(false)
    expect(isCredentialPath('/work/apps/gh/hosts.yml')).toBe(false)
    expect(isCredentialPath('/work/kube/config')).toBe(false)
  })

  it('sees the same file through an empty-quote split and the proc environ dump', () => {
    // A POSIX shell concatenates the words around `''`, so `.e''nv` opens `.env`:
    // the same file, spelled so that neither the path tools nor the command scan
    // recognized it. And on Linux `/proc/self/environ` is the whole environment
    // read as a path — the same dump the `printenv` rule refuses.
    expect(bashCredentialDenial("cat .e''nv")).toContain('credential guard')
    expect(bashCredentialDenial('cat .e"nv"')).toContain('credential guard')
    expect(credentialReadDenial('read', { path: ".e''nv" })).toContain('credential guard')
    expect(credentialReadDenial('write', { path: ".e''nv" })).toContain('credential guard')
    for (const path of ['/proc/self/environ', '/proc/1/environ', 'C:/proc/self/environ']) {
      expect(bashCredentialDenial(`cat ${path}`), path).toContain('credential guard')
      expect(credentialReadDenial('read', { path }), path).toContain('credential guard')
    }
    // Ordinary names that merely look similar stay readable.
    expect(bashCredentialDenial('cat src/environment.ts')).toBeUndefined()
    expect(credentialReadDenial('read', { path: 'src/environ' })).toBeUndefined()
    expect(credentialReadDenial('read', { path: "it's-noted.md" })).toBeUndefined()
  })

  it('sees the same file through a backslash escape, and the PowerShell env dump', () => {
    // A POSIX shell removes a backslash before an ordinary character, so the word
    // `.en\v` reaches `cat` as `.env` — the same file as the empty-quote case
    // above, spelled so that neither the path tools nor the command scan
    // recognize it. PowerShell reaches the whole environment through the `Env:`
    // provider instead of a program named `env`, and `bashCommandOf` accepts
    // `pwsh`, so it arrives on the path `printenv` already uses.
    for (const command of ['cat .en\\v', 'cat .e\\nv', 'cat .\\env']) {
      expect(bashCredentialDenial(command), command).toContain('credential guard')
    }
    for (const command of [
      'pwsh -c "Get-ChildItem Env:"',
      'pwsh -Command "ls Env:"',
      'powershell -c "gci Env:"',
      'pwsh -c "[Environment]::GetEnvironmentVariables()"',
    ]) expect(bashCredentialDenial(command), command).toContain('credential guard')
    // Ordinary names that merely look similar stay readable.
    expect(bashCredentialDenial('pwsh -c "Get-ChildItem src"')).toBeUndefined()
  })

  it('denies reading a credential file and explains how to proceed', () => {
    expect(credentialReadDenial('read', { path: '/work/project/.env' })).toContain('credential guard')
    expect(credentialReadDenial('read', { file_path: '.env.local' })).toBeDefined()
    expect(credentialReadDenial('edit', { path: '/work/project/.npmrc' })).toBeDefined()
    expect(credentialReadDenial('read', { path: '/work/project/src/main.ts' })).toBeUndefined()
  })

  it('denies a search tool that would print the credential file it names', () => {
    // `grep` returns the matching *lines*, so it is a file read whose name does not
    // say so — the same reason `spill_recall` is on the list. It was the one
    // content-returning tool the shield was not pointed at, so `grep({ path: '.env' })`
    // printed the file that `read` refuses.
    expect(credentialReadDenial('grep', { pattern: '.', path: '.env' })).toContain('credential guard')
    expect(credentialReadDenial('grep', { pattern: '.', path: '/work/project/.env.local' })).toContain('credential guard')
    // A filter names the file as directly as `path` does, and a wildcard spelling
    // must not be the way past a rule that reads basenames: `include` is one positive
    // filename glob, and Claude's `Grep` spells the same filter `glob`.
    expect(credentialReadDenial('grep', { pattern: '.', path: '.', include: '*.env' })).toContain('credential guard')
    expect(credentialReadDenial('grep', { pattern: '.', path: '.', glob: '**/id_rsa' })).toContain('credential guard')
    // Brace / trailing-star spellings still select the credential file; concatenating
    // alternatives or leaving a trailing bare dot used to make the shield miss them.
    expect(credentialReadDenial('grep', { pattern: '.', path: '.', include: '*.{env,md}' })).toContain('credential guard')
    expect(credentialReadDenial('grep', { pattern: '.', path: '.', glob: '{.env,.npmrc}' })).toContain('credential guard')
    expect(credentialReadDenial('grep', { pattern: '.', path: '.', include: '*.env.*' })).toContain('credential guard')
    // A filter that cannot select a credential file leaves ordinary searching alone,
    // and the example files stay readable.
    expect(credentialReadDenial('grep', { pattern: 'TODO', path: 'src', include: '*.md' })).toBeUndefined()
    expect(credentialReadDenial('grep', { pattern: 'PORT', include: '*.env.example' })).toBeUndefined()
  })

  it('denies whole-environment dumps and secret paths in bash commands', () => {
    expect(bashCredentialDenial('env')).toContain('credential guard')
    expect(bashCredentialDenial('printenv | grep TOKEN')).toContain('credential guard')
    expect(bashCredentialDenial('cat /work/project/.env')).toContain('credential guard')
    expect(bashCredentialDenial('cp .env /tmp/exfil')).toContain('credential guard')
    expect(bashCredentialDenial('cat /home/u/.ssh/id_rsa')).toContain('credential guard')
    // A leading assignment, a launcher wrapper, or quoting must not hide a dump.
    expect(bashCredentialDenial('FOO=bar printenv')).toContain('credential guard')
    expect(bashCredentialDenial('command printenv')).toContain('credential guard')
    expect(bashCredentialDenial('"printenv"')).toContain('credential guard')
    expect(bashCredentialDenial('sudo env')).toContain('credential guard')
    // The same prefix family as the command policy's launcher list, which is why
    // both lists are one vocabulary: `time printenv` prints the same dump as
    // `printenv`, and a guard that knows `command` but not `time` is bypassable by
    // a word nobody thought to write down.
    expect(bashCredentialDenial('time printenv')).toContain('credential guard')
    expect(bashCredentialDenial('timeout 5 printenv')).toContain('credential guard')
    expect(bashCredentialDenial('xargs printenv')).toContain('credential guard')
    expect(bashCredentialDenial('watch printenv')).toContain('credential guard')
    // Ordinary work stays allowed.
    expect(bashCredentialDenial('cat src/main.ts')).toBeUndefined()
    expect(bashCredentialDenial('git status')).toBeUndefined()
    expect(bashCredentialDenial('npm run build')).toBeUndefined()
    expect(bashCredentialDenial('')).toBeUndefined()
  })

  it('screens every shell a command can arrive under, not only `bash`', () => {
    // The shell tool-name list had a second copy here: this guard checked
    // `toolName === 'bash'` while the command policy checked `bash | shell |
    // exec_command`, so one command was judged by one tier and invisible to the
    // other. Codex's shell approvals arrive as `shell`/`exec_command`, and a Windows
    // composition ships `pwsh` — the shell whose commands a user on that platform
    // actually runs — so `pwsh { command: 'cat .env' }` reached no credential screen
    // while the same command under `bash` was refused.
    for (const tool of ['pwsh', 'shell', 'exec_command'] as const) {
      expect(credentialReadDenial(tool, { command: 'cat .env' }), tool).toContain('credential guard')
    }
    // PowerShell's own spelling of the same read names the file just as plainly.
    expect(credentialReadDenial('pwsh', { command: 'Get-Content .env' })).toContain('credential guard')
    // Ordinary commands under either spelling stay allowed.
    expect(credentialReadDenial('pwsh', { command: 'Get-ChildItem src' })).toBeUndefined()
    expect(credentialReadDenial('shell', { command: 'git status' })).toBeUndefined()
  })

  it('does not treat env-prefixed flags or command names as secret paths', () => {
    expect(bashCredentialDenial('ENV=prod npm run deploy')).toBeUndefined()
    expect(bashCredentialDenial('node scripts/env-check.ts')).toBeUndefined()
    expect(bashCredentialDenial('echo .env.example')).toBeUndefined()
    // `printenv` as an argument to another program is not an environment dump.
    expect(bashCredentialDenial('grep printenv docs/README.md')).toBeUndefined()
    expect(bashCredentialDenial('which printenv')).toBeUndefined()
  })
  it('resolves the shell expansions that hide a credential name', () => {
    // The scan splits on whitespace and shell separators, so every expansion
    // below happens *after* the split and is invisible to it. All four spellings
    // were measured returning `undefined` through `credentialReadDenial` before
    // this pass existed.
    //
    // A glob never equals the file it matches, and the literal part of the
    // pattern is the part that is known: whether it matches one file or ten,
    // `.env`'s bytes are among what the program receives.
    expect(bashCredentialDenial('cat .env*')).toContain('credential guard')
    expect(bashCredentialDenial('cp .env.local? /tmp/exfil')).toContain('credential guard')
    expect(bashCredentialDenial('cat .en?v')).toContain('credential guard')
    expect(bashCredentialDenial('cp {.env,notes.txt} /tmp/exfil')).toContain('credential guard')
    // An assignment is a word like any other, and the variable is a second name
    // for the value it was given earlier in the same command.
    expect(bashCredentialDenial('F=.env; cat $F')).toContain('credential guard')
    expect(bashCredentialDenial('F=.env; cat "$F"')).toContain('credential guard')
    expect(bashCredentialDenial('export F=id_rsa; ssh -i $F host')).toContain('credential guard')
    // A value behind `=` in an argument position is the same bytes as an
    // assignment; only the dashed spelling was read.
    expect(bashCredentialDenial('dd if=.env')).toContain('credential guard')
    expect(bashCredentialDenial('tar -cf out.tar --files-from=.env')).toContain('credential guard')
    // Command substitution is a command of its own, and it runs before the outer
    // word is built.
    expect(bashCredentialDenial('cat "$(echo .env)"')).toContain('credential guard')
    expect(bashCredentialDenial('cat `echo .env`')).toContain('credential guard')
    expect(bashCredentialDenial('cat "$(printf %s .env)"')).toContain('credential guard')
    expect(bashCredentialDenial('echo "$(printenv)"')).toContain('credential guard')
    // Reading expansions is not rewriting the line: ordinary commands keep
    // working, including the ones whose expansions cannot be known here.
    expect(bashCredentialDenial('ls src/*.ts')).toBeUndefined()
    expect(bashCredentialDenial('cat $UNSET_OR_EXPORTED')).toBeUndefined()
    expect(bashCredentialDenial('cd $HOME && git status')).toBeUndefined()
    expect(bashCredentialDenial('echo limit=$LIMIT')).toBeUndefined()
    expect(bashCredentialDenial('cat "$(git rev-parse HEAD)"')).toBeUndefined()
    expect(bashCredentialDenial('ENV=prod npm run deploy')).toBeUndefined()
  })
  it('denies a dump reached through the argument position find -exec uses', () => {
    // `-exec` names its command in an argument, and the shared prefix skip only
    // removes a *prefix*: `find . -exec printenv {} +` was read as `find`, so the
    // whole environment reached the model's context through a program nobody had
    // to write down. The program positions are the command policy's list, so no
    // reader of it can learn only the prefix half.
    expect(bashCredentialDenial('find . -exec printenv {} +')).toContain('credential guard')
    expect(bashCredentialDenial('find . -execdir printenv {} +')).toContain('credential guard')
    expect(bashCredentialDenial("find . -name '*.txt' -exec printenv {} +")).toContain('credential guard')
    expect(bashCredentialDenial('sudo find . -exec printenv {} +')).toContain('credential guard')
    // The operand carries its own launcher prefix, which is skipped there too.
    expect(bashCredentialDenial('find . -exec sudo printenv ;')).toContain('credential guard')
    // Judging the operand is not a ban on `-exec`: an operand that runs something
    // harmless stays allowed, and so does a dump command named as an argument.
    expect(bashCredentialDenial('find . -name \'*.ts\' -exec md5sum {} +')).toBeUndefined()
    expect(bashCredentialDenial('find . -exec grep -l printenv {} +')).toBeUndefined()
    expect(bashCredentialDenial('find . -exec echo printenv ;')).toBeUndefined()
  })

  it('sees through the Win32 spellings of the same file', () => {
    // Trailing dots and spaces are stripped by the Win32 layer, so these open
    // `.env` and `id_rsa` respectively. A guard that compared literals would let
    // both through while blocking the plain spelling.
    expect(isCredentialPath('C:\\work\\project\\.env.')).toBe(true)
    expect(isCredentialPath('C:\\work\\project\\.env ')).toBe(true)
    expect(isCredentialPath('C:\\Users\\u\\.ssh\\id_rsa ')).toBe(true)
    expect(isCredentialPath('C:\\work\\.ssh.\\id_rsa')).toBe(true)
    // An NTFS alternate data stream is named `file:stream`, so the segment is
    // judged by the *file* it opens — not by the stream suffix, which is why a
    // stream call on an innocent file stays allowed and a stream of `.env` does
    // not slip past the extension-less spelling.
    expect(isCredentialPath('C:\\work\\.env:Zone.Identifier')).toBe(true)
    expect(isCredentialPath('C:\\work\\notes.txt:.env')).toBe(false)
    // The drive-letter colon is not a stream separator.
    expect(isCredentialPath('C:\\work\\src\\main.ts')).toBe(false)
    // A trailing separator must not hide the last real segment.
    expect(isCredentialPath('/home/u/.ssh/')).toBe(true)
    expect(isCredentialPath('/work/project/.env.local/')).toBe(true)
  })

  it('matches credential directories per segment, not by substring', () => {
    // A project legitimately named after one of these must stay readable.
    expect(isCredentialPath('/work/.ssh-backup/notes.md')).toBe(false)
    expect(isCredentialPath('/work/.aws-region/config.json')).toBe(false)
    expect(isCredentialPath('/work/not.ssh/id_rsa.example.txt')).toBe(false)
    // The real directories still match at any depth.
    expect(isCredentialPath('/a/b/.gnupg/secring.gpg')).toBe(true)
    expect(isCredentialPath('/a/b/.aws/credentials')).toBe(true)
  })
})

describe('credential realpath guard', () => {
  const roots: string[] = []
  afterAll(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  })
  const scratch = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'freecodego-guard-'))
    roots.push(root)
    return root
  }

  it('denies a symlink whose target is a credential file', async () => {
    const root = await scratch()
    const secret = join(root, '.env')
    await writeFile(secret, 'TOKEN=1\n')
    const link = join(root, 'notes.md')
    await symlink(secret, link)
    // The lexical tier is blind to this: the name it was given is innocent.
    expect(isCredentialPath(link)).toBe(false)
    const denial = await credentialRealpathDenial('read', { path: link })
    expect(denial).toContain('resolves through a symlink or an alternate name')
  })

  it('judges every path a call names, not the first one it states', () => {
    // The shield read the first non-null of `path`/`file_path`/`locator`, so a call
    // carrying a safe path first and the credential second was judged by the safe
    // one, and a call spelling its target `paths`, `filename` or `target_file` was
    // judged by nothing at all. The deny list read every key and refused those
    // calls, which hid the gap for as long as a sandbox profile was configured —
    // and only for that long. `sandbox/profiles.ts` states the rule this restores:
    // a judgment that stopped at the first path is a bypass, not a tradeoff.
    for (const args of [
      { path: 'src/a.ts', file_path: '.env' },
      { paths: ['src/a.ts', '.env'] },
      { files: ['.env'] },
      { target_file: '.env' },
      { filename: '.env' },
      { locator: '.env' },
    ]) {
      expect(credentialReadDenial('read', args), JSON.stringify(args)).toContain('credential guard')
    }
    // The notebook spelling is the pair that was missing from every judgment list
    // while the native projection knew it: the engine's call was re-keyed onto
    // `path` and judged, and the same call from a Harness `notebook_edit` — a tool
    // name this guard already lists — was judged by nothing.
    for (const key of ['notebook_path', 'notebookPath'] as const) {
      for (const tool of ['notebook_edit', 'notebook_write']) {
        expect(credentialReadDenial(tool, { [key]: '.env' }), `${tool} ${key}`).toContain('credential guard')
      }
    }
    // And a call that names no credential is still allowed through to the rest of
    // the guard chain: this is a shield, not a blanket refusal of file tools.
    expect(credentialReadDenial('read', { path: 'src/a.ts', file_path: 'src/b.ts' })).toBeUndefined()
    expect(credentialReadDenial('read', { paths: ['src/a.ts', 'src/b.ts'] })).toBeUndefined()
  })

  it('resolves every named path through symlinks, not only the first', async () => {
    const root = await scratch()
    const secret = join(root, '.env')
    await writeFile(secret, 'TOKEN=1\n')
    const link = join(root, 'notes.md')
    await symlink(secret, link)
    // The audit tier has the same plural rule as the lexical tier. A call that
    // names an ordinary file first and a symlinked credential second used to be
    // resolved once, against the ordinary file.
    expect(await credentialRealpathDenial('read', { path: join(root, 'plain.txt'), file_path: link })).toContain('resolves through a symlink or an alternate name')
    expect(await credentialRealpathDenial('read', { paths: [join(root, 'plain.txt'), link] })).toContain('resolves through a symlink or an alternate name')
    // A call that resolves to ordinary files stays allowed.
    expect(await credentialRealpathDenial('read', { path: join(root, 'plain.txt'), file_path: join(root, 'other.txt') })).toBeUndefined()
  })

  it('resolves a symlink for every write tool the guards are pointed at', async () => {
    const root = await scratch()
    const secret = join(root, '.env')
    await writeFile(secret, 'TOKEN=1\n')
    const link = join(root, 'notes.md')
    await symlink(secret, link)
    // These are the names the native engines send. The list is curated the same
    // way Plan Mode curates its own: a name that does not exist is inert, while a
    // missing name is a hole a write tool walks through.
    for (const tool of ['multi_edit', 'notebook_edit', 'apply_patch', 'str_replace_editor']) {
      expect(credentialReadDenial(tool, { path: join(root, '.env') })).toContain('credential guard')
      expect(await credentialRealpathDenial(tool, { path: link })).toContain('resolves through a symlink or an alternate name')
    }
  })

  it('resolves the nearest existing ancestor for a file that does not exist yet', async () => {
    const root = await scratch()
    await symlink(join(root, 'secret-dir'), join(root, 'linked-dir')).catch(() => undefined)
    // A `write` target that does not exist still resolves through the link above it.
    expect(await credentialRealpathDenial('write', { path: join(root, 'plain', 'new.txt') })).toBeUndefined()
    expect(await credentialRealpathDenial('read', { path: join(root, 'plain', 'new.txt') })).toBeUndefined()
  })

  it('leaves ordinary paths, missing paths, and other tools alone', async () => {
    const root = await scratch()
    await writeFile(join(root, 'main.ts'), 'export {}\n')
    expect(await credentialRealpathDenial('read', { path: join(root, 'main.ts') })).toBeUndefined()
    // The lexical tier already answers these; the syscall would only repeat it.
    expect(await credentialRealpathDenial('read', { path: join(root, '.env') })).toContain('credential guard')
    expect(await credentialRealpathDenial('bash', { command: 'cat x' })).toBeUndefined()
    expect(await credentialRealpathDenial('read', {})).toBeUndefined()
    expect(await credentialRealpathDenial('read', { path: 42 })).toBeUndefined()
  })
})

describe('doom loop guard', () => {
  const exec = (name: string, args: unknown, id = 'agent-1') => ({ name, arguments: args, agent: { id } }) as never

  it('denies the third identical call and holds the denial during cooldown', () => {
    let time = 0
    const guard = new DoomLoopGuard({ now: () => time, cooldownMs: 60_000, threshold: 3 })
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toBeUndefined()
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toBeUndefined()
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toContain('Doom loop detected')
    // Cooldown holds while time barely advances, regardless of the window.
    time += 1_000
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toContain('Doom loop detected')
  })

  it('re-arms after the cooldown expires and counts different arguments separately', () => {
    let time = 0
    const guard = new DoomLoopGuard({ now: () => time, cooldownMs: 60_000, windowMs: 120_000, threshold: 3 })
    for (let index = 0; index < 3; index += 1) guard.deny(exec('bash', { command: 'npm test' }))
    time += 61_000
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toBeUndefined()
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toBeUndefined()
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toContain('Doom loop detected')
    // Different arguments are a different fingerprint.
    expect(guard.deny(exec('bash', { command: 'npm run build' }))).toBeUndefined()
    expect(guard.deny(exec('read', { path: 'src/a.ts' }))).toBeUndefined()
  })

  it('ignores calls older than the sliding window', () => {
    let time = 0
    const guard = new DoomLoopGuard({ now: () => time, windowMs: 10 * 60_000, threshold: 3 })
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toBeUndefined()
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toBeUndefined()
    time += 11 * 60_000
    expect(guard.deny(exec('bash', { command: 'npm test' }))).toBeUndefined()
  })

  it('zeroes the denial count on clear(), as the counter documents and its siblings already do', () => {
    // The getter promised "since construction (or the last clear())" while `clear()`
    // left the counter behind, so the one stat whose job is to be read next to the
    // reset ("how many were denied in the window you just cleaned") kept reporting
    // denials from before it. `wastedChars` is cleared with the same call, which is
    // what made the disagreement a defect rather than a choice.
    const guard = new DoomLoopGuard({ now: () => 0, threshold: 2 })
    for (let index = 0; index < 4; index += 1) guard.deny(exec('bash', { command: 'npm test' }, 'agent-a'))
    expect(guard.denialCount).toBeGreaterThan(0)
    guard.clear()
    expect(guard.denialCount).toBe(0)
    expect(guard.wastedChars).toBe(0)
  })

  it('counts per agent and exempts polling tools', () => {
    const time = 0
    const guard = new DoomLoopGuard({ now: () => time, threshold: 3 })
    for (let index = 0; index < 3; index += 1) guard.deny(exec('bash', { command: 'npm test' }, 'agent-a'))
    expect(guard.deny(exec('bash', { command: 'npm test' }, 'agent-b'))).toBeUndefined()
    // Job polling legitimately repeats.
    for (let index = 0; index < 5; index += 1) {
      expect(guard.deny(exec('job_output', { id: 'job-1' }))).toBeUndefined()
    }
  })

  it('bounds the cumulative cost map instead of growing with every distinct call', () => {
    const guard = new DoomLoopGuard({ now: () => 0 })
    // Fixed-width indices keep every payload the same length, so the total is a
    // clean multiple of the per-call cost and the bound is checkable.
    const args = (index: number) => ({ path: `/w/${String(index).padStart(5, '0')}.ts` })
    expect(guard.deny(exec('read', args(0)))).toBeUndefined()
    const perCall = guard.wastedChars
    guard.clear()
    for (let index = 0; index < 20_000; index += 1) guard.deny(exec('read', args(index)))
    // Every call was distinct, so an unbounded map would retain all 20k payloads.
    expect(guard.wastedChars).toBeLessThan(20_000 * perCall)
    // The recent working set stays exact rather than being flushed wholesale.
    expect(guard.wastedChars).toBeGreaterThan(3_000 * perCall)
  })

  it('treats key-reordered object arguments as identical', () => {
    const time = 0
    const guard = new DoomLoopGuard({ now: () => time, threshold: 3 })
    expect(guard.deny(exec('bash', { command: 'npm test', cwd: '/w' }))).toBeUndefined()
    expect(guard.deny(exec('bash', { cwd: '/w', command: 'npm test' }))).toBeUndefined()
    expect(guard.deny(exec('bash', { command: 'npm test', cwd: '/w' }))).toContain('Doom loop detected')
  })

  it('counts an exactly-repeating call once, not once per axis', () => {
    // An unnormalized call is identical on both axes; counting it twice would
    // halve the exact threshold and deny the second legitimate call.
    const time = 0
    const guard = new DoomLoopGuard({ now: () => time, threshold: 3 })
    expect(guard.deny(exec('read', { path: 'src/a.ts' }))).toBeUndefined()
    expect(guard.deny(exec('read', { path: 'src/a.ts' }))).toBeUndefined()
    expect(guard.deny(exec('read', { path: 'src/a.ts' }))).toContain('Doom loop detected')
  })

  it('catches a loop that only varies the spelling of a path', () => {
    // The exact fingerprint never repeats here, so before the near-duplicate
    // axis this loop was invisible for as long as the model kept alternating.
    const time = 0
    const guard = new DoomLoopGuard({ now: () => time, threshold: 3, nearDuplicateThreshold: 6 })
    const spellings = ['src/a.ts', './src/a.ts', 'src//a.ts', ' src/a.ts ', 'src/a.ts', './src/a.ts']
    for (const path of spellings.slice(0, 5)) {
      expect(guard.deny(exec('read', { path }))).toBeUndefined()
    }
    const denial = guard.deny(exec('read', { path: spellings[5] }))
    expect(denial).toContain('Doom loop detected')
    // The message names the axis, so the model looks for a repetition it made.
    expect(denial).toContain('path spelling')
  })

  it('does not merge arguments whose difference can change the call', () => {
    // Internal whitespace in a shell command can sit inside a quoted string, a
    // backslash is an ordinary filename character on POSIX, and a URL's `//` is
    // not a path separator. None of these may be treated as a repetition.
    const time = 0
    // Two calls per spelling: below the exact threshold, so any denial here
    // would have to have come from the near-duplicate axis merging them.
    const guard = new DoomLoopGuard({ now: () => time, threshold: 3, nearDuplicateThreshold: 3 })
    expect(guard.deny(exec('bash', { command: 'echo "a  b"' }))).toBeUndefined()
    expect(guard.deny(exec('bash', { command: 'echo "a b"' }))).toBeUndefined()
    expect(guard.deny(exec('read', { path: 'a\\b' }))).toBeUndefined()
    expect(guard.deny(exec('read', { path: 'a/b' }))).toBeUndefined()
    expect(guard.deny(exec('fetch', { url: 'https://x/y' }))).toBeUndefined()
    expect(guard.deny(exec('fetch', { url: 'https:/x/y' }))).toBeUndefined()
  })

  it('shares one chain across a lineage only when asked, and only at the high bar', () => {
    const time = 0
    const guard = new DoomLoopGuard({ now: () => time, threshold: 3, nearDuplicateThreshold: 4, shareThreshold: 8, chainKey: () => 'root-parent' })
    // Three calls spread over a parent and its children stay below the shared
    // bar: a fan-out where each agent reads the file once is legitimate work.
    for (const id of ['parent', 'child-1', 'child-2']) {
      expect(guard.deny(exec('read', { path: 'src/a.ts' }, id))).toBeUndefined()
    }
    // The fourth is where the per-agent near chain would have fired for a
    // single agent; across a lineage it is still five calls short of a loop.
    expect(guard.deny(exec('read', { path: 'src/a.ts' }, 'child-3'))).toBeUndefined()
    for (const id of ['child-4', 'child-5', 'child-6']) {
      expect(guard.deny(exec('read', { path: 'src/a.ts' }, id))).toBeUndefined()
    }
    const denial = guard.deny(exec('read', { path: 'src/a.ts' }, 'child-7'))
    expect(denial).toContain('Doom loop detected')
    expect(denial).toContain('subagents')
  })

  it('bills the cost on the coarsest chain, so a lineage shares one budget', () => {
    const time = 0
    const payload = { path: `src/${'x'.repeat(2_000)}.ts` }
    const perCall = stableJson(payload).length
    // A budget between one call and two: only a bucket that both agents pay into
    // reaches the escalation note. This is the difference between the coarsest
    // chain (lineage) and the near-identical chain (per agent).
    const budget = Math.round(perCall * 1.5)
    const shared = new DoomLoopGuard({ now: () => time, threshold: 2, nearDuplicateThreshold: 2, shareThreshold: 2, costBudgetChars: budget, chainKey: () => 'root-parent' })
    expect(shared.deny(exec('read', payload, 'parent'))).toBeUndefined()
    const across = shared.deny(exec('read', payload, 'child-1'))
    expect(across).toContain('already consumed')
    // Without a lineage key the same two calls are two agents' separate buckets,
    // neither of which crosses the budget on its own.
    const solo = new DoomLoopGuard({ now: () => time, threshold: 2, nearDuplicateThreshold: 2, costBudgetChars: budget })
    expect(solo.deny(exec('read', payload, 'parent'))).toBeUndefined()
    expect(solo.deny(exec('read', payload, 'child-1'))).toBeUndefined()
  })

  it('leaves the lineage chain off when no chainKey is supplied', () => {
    const time = 0
    const guard = new DoomLoopGuard({ now: () => time, threshold: 3, shareThreshold: 3 })
    for (const id of ['parent', 'child-1', 'child-2', 'child-3']) {
      expect(guard.deny(exec('read', { path: 'src/a.ts' }, id))).toBeUndefined()
    }
  })
})
