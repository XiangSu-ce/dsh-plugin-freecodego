/**
 * The design page: one master switch plus a row per design capability.
 *
 * The page is a container rather than a single feature's panel, because the
 * capabilities are independent products — each has its own asset root, its own
 * tool set, and its own reason to be off. A row says what the capability does,
 * what it adds, and whether it is available on this machine, so the user is
 * choosing with the cost visible instead of discovering it after the tokens are
 * spent.
 *
 * The section is registered unconditionally. A page that only appears once its
 * switch is on cannot be the place the switch is turned on from — and the
 * container has no other seat, unlike the engineering pack, whose master switch
 * lives on the plugin's own settings tab.
 *
 * @module client/design-section
 */

import { useCallback, useEffect, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { FreeCodeGoDesignStatus } from '@deepseek-ai/dsh-freecodego-harness-plugin'
import css from './design-section.module.css'

/** Locale keys this section renders. */
export type DesignSectionLocaleKey =
  | 'design' | 'designIntro' | 'designMasterOn' | 'designMasterOff'
  | 'designTools' | 'designLoading' | 'designLoadFailed' | 'designWriteFailed'

/**
 * What the registration injects.
 *
 * The name is a contract, not a style choice: `remote-contract.spec` sweeps
 * every `*SectionInjected` interface and requires some slot's inject face to
 * provide each of its props. Named anything else, this section compiled and ran
 * while sitting outside that sweep — an inject face that lost a prop would have
 * failed at runtime as "did not become available" instead of in a test.
 */
export interface DesignSectionInjected {
  readonly status: () => Promise<RemoteResult<FreeCodeGoDesignStatus>>
  readonly setEnabled: (enabled: boolean) => Promise<RemoteResult<FreeCodeGoDesignStatus>>
  readonly setFeatureEnabled: (id: string, enabled: boolean) => Promise<RemoteResult<FreeCodeGoDesignStatus>>
  readonly t: (key: DesignSectionLocaleKey) => string
}

/** One labelled switch, used for the master and for every feature row. */
function Switch(props: {
  readonly checked: boolean
  readonly disabled?: boolean
  readonly busy: boolean
  readonly label: string
  readonly onChange: (next: boolean) => void
}): React.ReactElement {
  const blocked = props.disabled === true || props.busy
  return (
    <label className={css.switch}>
      <input
        type="checkbox"
        className={css.switchInput}
        checked={props.checked}
        disabled={blocked}
        aria-label={props.label}
        onChange={(event) => {
          // `disabled` is the first guard, not the only one. A browser does not
          // emit a change event from a disabled control, but the two invariants
          // this page carries — an unavailable feature cannot be switched on,
          // and nothing is sent while a write is in flight — belong where the
          // decision is made rather than in whatever happens to honour the
          // attribute. Driving the control synthetically (an automation layer, a
          // replacement widget) otherwise reaches the Host through a path the
          // user cannot, and `design-section.client.spec` pins that it does not.
          if (blocked) return
          props.onChange(event.target.checked)
        }}
      />
      <span className={css.track} />
    </label>
  )
}

/** The design settings section. */
export function DesignSection(props: DesignSectionInjected): React.ReactElement {
  const { t } = props
  const [snapshot, setSnapshot] = useState<FreeCodeGoDesignStatus | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void props.status().then((result) => {
      if (!live) return
      if (result.ok) setSnapshot(result.value)
      else setFailure(t('designLoadFailed'))
    }).catch(() => { if (live) setFailure(t('designLoadFailed')) })
    return () => { live = false }
  }, [props, t])

  /**
   * Run one write and adopt the status it returns.
   *
   * The Host answers a write with the state it now holds, which is what the page
   * renders next. Re-reading instead would show a value that a concurrent change
   * could have moved past, and guessing from the request would show what was
   * asked for rather than what was stored.
   */
  const write = useCallback(async (call: () => Promise<RemoteResult<FreeCodeGoDesignStatus>>): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await call()
      if (result.ok) setSnapshot(result.value)
      else setFailure(t('designWriteFailed'))
    } catch {
      setFailure(t('designWriteFailed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  if (snapshot === undefined) {
    return (
      <div className={css.page}>
        <p className={failure === undefined ? css.loading : css.error}>{failure ?? t('designLoading')}</p>
      </div>
    )
  }

  return (
    <div className={css.page}>
      <div className={css.head}>
        <div>
          <h2 className={css.title}>{t('design')}</h2>
          <p className={css.intro}>{t('designIntro')}</p>
        </div>
        <Switch
          checked={snapshot.designEnabled}
          busy={busy}
          label={snapshot.designEnabled ? t('designMasterOn') : t('designMasterOff')}
          onChange={(next) => { void write(() => props.setEnabled(next)) }}
        />
      </div>
      {failure === undefined ? null : <p className={css.error}>{failure}</p>}
      <ul className={css.list}>
        {snapshot.features.map(feature => (
          <li key={feature.id} className={css.row}>
            <div className={css.rowHead}>
              <span className={css.rowTitle}>{feature.label}</span>
              <Switch
                checked={feature.enabled}
                disabled={!feature.available}
                busy={busy}
                label={feature.label}
                onChange={(next) => { void write(() => props.setFeatureEnabled(feature.id, next)) }}
              />
            </div>
            <p className={css.rowBody}>{feature.summary}</p>
            {feature.tools.length === 0 ? null : (
              <div>
                <div className={css.meta}>{t('designTools')}</div>
                <ul className={css.tools}>
                  {feature.tools.map(tool => <li key={tool} className={css.tool}>{tool}</li>)}
                </ul>
              </div>
            )}
            <div className={css.meta}>{feature.detail}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
