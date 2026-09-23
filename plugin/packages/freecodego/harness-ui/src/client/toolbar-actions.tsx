import { useEffect, useState, type ReactNode } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './toolbar-actions.module.css'
import { VoiceInputButton } from './voice-input.tsx'

export interface LanguageActionProps {
  readonly locale: LocaleRuntime
  readonly t: TranslateNS<'settings.freecodego'>
}

export function LanguageAction({ locale, t }: LanguageActionProps): ReactNode {
  const active = locale.getLocale().active
  const next = active === 'zh' ? 'en' : 'zh'
  return <button className={css.action} type="button" onClick={() => { locale.setLocale(next) }} title={t('language.switch')} aria-label={t('language.switch')}>
    <IconGlobeOutlineRegular />
    <span>{active === 'zh' ? '中' : 'EN'}</span>
  </button>
}

interface EngineInfo { readonly id: string; readonly availability: string }
type SessionExecution = { readonly engine: string; readonly executor: 'native' | 'adapter-loop'; readonly provider: string; readonly model: string }
export interface EngineActionProps {
  readonly catalog: () => Promise<{ readonly ok: boolean; readonly value?: { readonly defaultEngine: string; readonly engines: readonly EngineInfo[] }; readonly error?: { readonly message: string } }>
  readonly setDefaultEngine: (engine: 'deepseek' | 'codex' | 'claude') => Promise<{ readonly ok: boolean; readonly error?: { readonly message: string } }>
  // `| undefined` is required (not merely optional) because the injector passes
  // `currentSessionId()` verbatim and exactOptionalPropertyTypes would reject
  // an explicit undefined.
  readonly sessionId?: string | undefined
  readonly useSession?: <T>(selector: (snapshot: { readonly blank: boolean }) => T) => T
  readonly voiceInputEnabled?: () => Promise<boolean>
  readonly voiceTranscribe?: (audioBase64: string, mimeType: string, language?: string) => Promise<{ readonly ok: boolean; readonly value?: { readonly text: string } }>
  readonly t: TranslateNS<'settings.freecodego'>
}

export interface VoiceInputActionProps {
  readonly voiceInputEnabled?: () => Promise<boolean>
  readonly voiceTranscribe?: (audioBase64: string, mimeType: string, language?: string) => Promise<{ readonly ok: boolean; readonly value?: { readonly text: string } }>
}

export function EngineAction({ catalog, setDefaultEngine, sessionId, useSession, t }: EngineActionProps): ReactNode {
  const [engine, setEngine] = useState<'deepseek' | 'codex' | 'claude'>('deepseek')
  const [available, setAvailable] = useState<readonly EngineInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [catalogError, setCatalogError] = useState<string | undefined>()
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const sessionBlank = useSession?.(snapshot => snapshot.blank) ?? false
  // A failed catalog read used to be swallowed twice over: a rejected promise had
  // no handler, and an `ok: false` reply returned early. Either way `available`
  // stayed empty, so the Codex/Claude options rendered disabled with no message
  // and no way out — the user saw an installed engine they could not pick.
  useEffect(() => {
    let live = true
    void catalog().then((result) => {
      if (!live) return
      if (!result.ok || result.value === undefined) {
        setCatalogError(result.error?.message ?? '')
        return
      }
      setCatalogError(undefined)
      setEngine(result.value.defaultEngine === 'codex' || result.value.defaultEngine === 'claude' ? result.value.defaultEngine : 'deepseek')
      setAvailable(result.value.engines)
    }, (reason: unknown) => {
      if (!live) return
      setCatalogError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { live = false }
  }, [catalog, catalogAttempt])
  // A failed engine switch must not leave the select silently reverted; the
  // inline message auto-clears so a later retry starts from a clean state.
  useEffect(() => {
    if (error === undefined) return
    const timer = globalThis.setTimeout(() => { setError(undefined) }, 5_000)
    return () => { globalThis.clearTimeout(timer) }
  }, [error])
  const codexAvailable = available.some(item => item.id === 'codex' && item.availability === 'available')
  const claudeAvailable = available.some(item => item.id === 'claude' && item.availability === 'available')
  return <div className={css.engineControl}>
    <label className={css.engine} title={t('engineHint')}>
      <span className={css.engineLabel}>{t('engineShort')}</span>
      <select className={css.engineSelect} value={engine} disabled={busy} onChange={(event) => {
        const next = event.target.value === 'codex' || event.target.value === 'claude' ? event.target.value : 'deepseek'
        setBusy(true)
        setError(undefined)
        void setDefaultEngine(next).then((result) => {
          if (!result.ok) {
            setError(result.error?.message ?? t('engineSwitchFailed'))
            return
          }
          // Another surface (toolbar vs settings) can switch the engine while
          // this request was in flight; re-read the authoritative default so
          // the select never shows a value the backend no longer has.
          void catalog().then((recheck) => {
            const live = recheck.ok && recheck.value !== undefined && (recheck.value.defaultEngine === 'codex' || recheck.value.defaultEngine === 'claude')
              ? recheck.value.defaultEngine
              : next
            setEngine(live)
            // The active session is pinned at creation time. Compare the
            // selector value immediately so the notice is deterministic.
            setNotice(sessionId !== undefined && !sessionBlank && engine !== live)
          }, () => {
            setEngine(next)
            setNotice(sessionId !== undefined && !sessionBlank && engine !== next)
          })
        }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : t('engineSwitchFailed')) }).finally(() => { setBusy(false) })
      }}>
        <option value="deepseek">{t('engineDeepseek')}</option>
        <option value="codex" disabled={!codexAvailable}>{t('engineCodex')}</option>
        <option value="claude" disabled={!claudeAvailable}>{t('engineClaude')}</option>
      </select>
    </label>
    {error === undefined ? null : <div className={css.engineError} role="alert">{error}</div>}
    {catalogError === undefined ? null : <div className={css.engineError} role="alert">
      <span>{t('engineCatalogFailed')}{catalogError === '' ? '' : ` ${catalogError}`}</span>
      <button className={css.engineRetry} type="button" onClick={() => { setCatalogAttempt(attempt => attempt + 1) }}>{t('engineRetry')}</button>
    </div>}
    {notice ? <div className={css.engineNotice} role="status">
      <strong>{t('engineSwitchTitle')}</strong>
      <span>{t('engineSwitchHint')}</span>
      <button type="button" onClick={() => { setNotice(false) }} aria-label={t('engineSwitchDismiss')}>×</button>
    </div> : null}
  </div>
}

/** Place voice capture immediately before the model selector in the trailing
 * composer controls, rather than beside the engine selector. */
export function VoiceInputAction({ voiceInputEnabled, voiceTranscribe }: VoiceInputActionProps): ReactNode {
  return voiceInputEnabled === undefined ? null : <VoiceInputButton isEnabled={voiceInputEnabled} transcribe={voiceTranscribe} />
}

export function EngineExecutionBadge({ sessionId, status, t }: {
  readonly sessionId?: string | undefined
  readonly status: (sessionId: string) => Promise<{ readonly ok: boolean; readonly value?: SessionExecution }>
  readonly t: TranslateNS<'settings.freecodego'>
}): ReactNode {
  const [value, setValue] = useState<SessionExecution | undefined>()
  useEffect(() => {
    // Slot injectors may omit the session id before a conversation exists;
    // firing the RPC without one would only produce a failed call.
    if (sessionId === undefined) return
    let live = true
    void status(sessionId).then((result) => { if (live && result.ok) setValue(result.value) }, () => undefined)
    return () => { live = false }
  }, [sessionId, status])
  if (value === undefined) return null
  const engine = value.engine === 'claude' ? t('engineClaude') : value.engine === 'codex' ? t('engineCodex') : t('engineDeepseek')
  const executor = value.executor === 'native' ? t('engineNative') : t('engineAdapter')
  const provider = value.provider.toLowerCase() === 'logfare' ? 'logfare' : value.provider
  return <span className={`${css.execution} ${value.executor === 'native' ? css.executionNative : ''}`} title={`${t('engineExecutionHint')} ${provider} / ${value.model.replace(/^logfare\//i, '')}`}>
    {engine} · {executor}
  </span>
}
