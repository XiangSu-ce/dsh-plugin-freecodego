/**
 * In-plugin detail dialog for community marketplace entries.
 *
 * The marketplace grids used to link every Skill and MCP card straight out to
 * the browser, which loses the plugin's own chrome, its Chinese copy, and any
 * translation the catalog already carries. This dialog keeps the user inside
 * the plugin: the catalog metadata renders immediately, the upstream README is
 * read in the background (Chinese first when the UI is Chinese), and opening
 * the source in a browser stays available as an explicit choice in the footer.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { capabilityText, localizedSkillDescription, skillPageText, upstreamEnglishHint } from './capability-locale.ts'
import { usePluginReadme } from './plugin-readme.ts'
import css from './settings-tab.module.css'

/** Structural shape shared by the community and MCP marketplace item types. */
export interface CapabilityDetailItem {
  readonly id: string
  readonly kind: 'mcp' | 'skill'
  readonly title: string
  readonly description: string
  readonly category: string
  readonly sourceUrl: string
  readonly iconUrl?: string | undefined
  readonly author?: string | undefined
  readonly popularity: number
  readonly installed: boolean
  readonly installable: boolean
  readonly requiresConfiguration?: boolean | undefined
}

function CapabilityTitleIcon({ item }: { readonly item: CapabilityDetailItem }): ReactNode {
  if (item.iconUrl !== undefined) return <img className={css.capabilityIcon} src={item.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
  return item.kind === 'mcp'
    ? <span className={`${css.capabilityIcon} ${css.capabilityIconMcp}`} aria-hidden="true">M</span>
    : <span className={css.capabilityIcon} aria-hidden="true">S</span>
}

/** Structural shape of one discovered Skill row on the library page. */
export interface SkillDetailItem {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** Body and companion files returned by the on-demand Skill read. */
export interface SkillDetailContent {
  readonly content: string
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
  readonly file?: { readonly path: string; readonly bytes: number; readonly content: string }
  /**
   * Skills this one's whole body forwards to, resolved by the Host.
   *
   * A few bundled Skills are thin aliases whose `SKILL.md` is a single
   * instruction to load another Skill, so the body tab reads as empty for the
   * entries a user is most likely to open. The Host resolves those targets and
   * this dialog shows their real bodies below, labelled, instead of pretending
   * the alias is the whole story.
   */
  readonly forwarded?: readonly { readonly name: string; readonly description: string; readonly content: string }[] | undefined
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
}

/**
 * Detail dialog for one Skill in the settings library.
 *
 * The library cards used to be inert text: a user could read a Skill's name and
 * one-line description and nothing else, so the only way to learn what a Skill
 * would do was to invoke it. This reads the body from the Host on open and lists
 * the sibling files, because several bundled Skills keep their real payload
 * there (`codebase-design/DESIGN-IT-TWICE.md`, `prototype/LOGIC.md`,
 * `wizard/template.sh`).
 */
export function SkillDetailModal(input: {
  readonly skill: SkillDetailItem
  readonly language: 'zh' | 'en'
  readonly load: (file?: string) => Promise<SkillDetailContent>
  /** Whether the user has overridden this Skill's invocation policy. */
  readonly overridden?: boolean | undefined
  /** Writes the model-invocation preference; absent when the Host offers none. */
  readonly onInvocation?: ((modelInvocable: boolean | undefined) => void) | undefined
  readonly invocationBusy?: boolean | undefined
  readonly onClose: () => void
}): ReactNode {
  const { skill, language, load, overridden, onInvocation, invocationBusy, onClose } = input
  const text = skillPageText(language)
  const [detail, setDetail] = useState<SkillDetailContent | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [activeFile, setActiveFile] = useState<string | undefined>(undefined)
  // The companion body is held apart from the Skill detail: the read that
  // answers `{ name, file }` returns the Skill body too, and keeping only the
  // last response would make every chip show the Skill body instead of the
  // file it was asked for.
  const [companion, setCompanion] = useState<SkillDetailContent['file']>(undefined)
  const [fileBusy, setFileBusy] = useState(false)
  const [fileError, setFileError] = useState<string | undefined>(undefined)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  // The loader is re-created on every parent render, so the fetch effect keys on
  // the Skill name and reads the current loader through a ref. Depending on the
  // function itself would refetch on every render of the panel behind it.
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    // Same focus contract as the marketplace dialog: focus moves into the
    // dialog and returns to whatever opened it.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    queueMicrotask(() => { closeRef.current?.focus() })
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      opener?.focus()
    }
  }, [onClose])

  useEffect(() => {
    let active = true
    setDetail(undefined)
    setError(undefined)
    setActiveFile(undefined)
    setCompanion(undefined)
    setFileError(undefined)
    void loadRef.current().then((value) => { if (active) setDetail(value) }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [skill.name])

  // Every chip click bumps this token, so a slow read cannot land on top of a
  // newer one: clicking `a.md` and then `b.md` used to leave the dialog showing
  // whichever of the two happened to answer last, body and highlighted chip
  // alike. The body chip counts as a request too, so a pending file read cannot
  // overwrite the Skill body the user just went back to.
  const fileRequestRef = useRef(0)
  const openFile = (path: string | undefined): void => {
    const request = fileRequestRef.current + 1
    fileRequestRef.current = request
    if (path === undefined) {
      setActiveFile(undefined)
      setCompanion(undefined)
      setFileError(undefined)
      return
    }
    setFileBusy(true)
    setFileError(undefined)
    void loadRef.current(path).then((value) => {
      if (fileRequestRef.current !== request) return
      setActiveFile(path)
      setCompanion(value.file)
    }, (reason: unknown) => {
      if (fileRequestRef.current !== request) return
      setActiveFile(undefined)
      setCompanion(undefined)
      setFileError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { if (fileRequestRef.current === request) setFileBusy(false) })
  }

  const invocation = skill.modelInvocable ? text.invocationAuto : skill.userInvocable ? text.invocationManual : text.invocationNone
  const body = activeFile === undefined ? detail?.content : companion?.content

  return <div className={css.communityModalBackdrop} role="presentation" onClick={onClose}>
    <article className={css.communityModal} role="dialog" aria-modal="true" aria-label={`${text.detailTitle}: ${skill.name}`} tabIndex={-1} onClick={(event) => { event.stopPropagation() }}>
      <header className={css.communityModalHeader}>
        <div>
          <div className={css.kicker}>{text.detailTitle}</div>
          <h3 className={css.communityModalTitle}>{skill.name}</h3>
          <small className={css.communityModalOwner}>{skill.source} · {invocation}</small>
        </div>
        <button ref={closeRef} className={css.button} type="button" onClick={onClose}>{text.detailClose}</button>
      </header>
      <p className={css.communityModalSummary}>{localizedSkillDescription(skill.name, skill.description, language)}</p>
      {onInvocation === undefined ? null : <div className={css.skillDetailControl}>
        <label className={css.skillCardToggle} title={text.autoInvokeHint}>
          <input
            type="checkbox"
            aria-label={`${text.autoInvoke}: ${skill.name}`}
            checked={skill.modelInvocable}
            disabled={invocationBusy === true}
            onChange={(event) => { onInvocation(event.target.checked) }}
          />
          {text.autoInvoke}
        </label>
        {overridden === true ? <button className={css.skillCardClear} type="button" disabled={invocationBusy === true} onClick={() => { onInvocation(undefined) }}>{text.followFile}</button> : null}
        <small className={css.skillCardControlHint}>{text.autoInvokeScope}</small>
      </div>}
      {!skill.modelInvocable ? <p className={css.sectionMeta}>{text.invocationHint}</p> : null}
      {error === undefined ? null : <div className={css.alert} role="alert">{text.detailError} {error}</div>}
      {detail === undefined && error === undefined ? <p className={css.loading}>{text.detailLoading}</p> : null}
      {detail === undefined ? null : <>
        {detail.files.length === 0 ? <p className={css.sectionMeta}>{text.detailCompanionEmpty}</p> : <div className={css.skillFileBar} role="group" aria-label={text.detailCompanion}>
          <button className={`${css.skillFileChip} ${activeFile === undefined ? css.skillFileChipActive : ''}`} type="button" onClick={() => { openFile(undefined) }}>{text.detailBody}</button>
          {detail.files.map(file => <button className={`${css.skillFileChip} ${activeFile === file.path ? css.skillFileChipActive : ''}`} key={file.path} type="button" onClick={() => { openFile(file.path) }}>{file.path} · {formatBytes(file.bytes)}</button>)}
        </div>}
        {fileBusy ? <p className={css.loading}>{text.detailFileLoading}</p> : null}
        {fileError === undefined ? null : <div className={css.alert} role="alert">{text.detailFileError} {fileError}</div>}
        {body === undefined ? null : <div className={css.communityReadme}><pre>{body}</pre></div>}
        {activeFile !== undefined || detail.forwarded === undefined || detail.forwarded.length === 0 ? null : detail.forwarded.map(target => <section className={css.skillForward} key={target.name}>
          <div className={css.skillForwardHead}>
            <strong>{text.forwardedTitle(target.name)}</strong>
            <small>{localizedSkillDescription(target.name, target.description, language)}</small>
          </div>
          <div className={css.communityReadme}><pre>{target.content}</pre></div>
        </section>)}
      </>}
      <footer className={css.communityModalFooter}>
        <button className={css.button} type="button" onClick={onClose}>{text.detailClose}</button>
      </footer>
    </article>
  </div>
}

export function CapabilityDetailModal(input: {
  readonly item: CapabilityDetailItem
  readonly language: 'zh' | 'en'
  readonly busy: boolean
  readonly onClose: () => void
  readonly onInstall?: (() => void) | undefined
}): ReactNode {
  const { item, language, busy, onClose, onInstall } = input
  const text = capabilityText(language)
  const readme = usePluginReadme(item.sourceUrl, language)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    // Restore focus to whatever opened the dialog, the same contract the
    // community plugin dialog keeps.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    queueMicrotask(() => { closeRef.current?.focus() })
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      opener?.focus()
    }
  }, [onClose])

  const installLabel = busy
    ? text.installing
    : item.installed
      ? text.installed
      : item.installable ? text.install : text.manual

  return <div className={css.communityModalBackdrop} role="presentation" onClick={onClose}>
    <article className={css.communityModal} role="dialog" aria-modal="true" aria-label={item.title} tabIndex={-1} onClick={(event) => { event.stopPropagation() }}>
      <header className={css.communityModalHeader}>
        <div>
          <div className={css.kicker}>{item.kind === 'mcp' ? text.kickerMcp : text.kickerSkill}</div>
          <CapabilityTitleIcon item={item} />
          <h3 className={css.communityModalTitle}>{item.title}</h3>
          <small className={css.communityModalOwner}>{item.author ?? item.category} · {item.category} · {text.popularity} {item.popularity.toLocaleString()}</small>
        </div>
        <button ref={closeRef} className={css.button} type="button" onClick={onClose}>{text.close}</button>
      </header>
      <p className={css.communityModalSummary}>{item.description}</p>
      {language === 'zh' ? <p className={css.sectionMeta}>{upstreamEnglishHint('zh')}</p> : null}
      {item.requiresConfiguration === true ? <div className={css.communityFeatureList}>{text.requiresConfiguration}</div> : null}
      <div className={css.communityModalStats}>
        <span className={css.sectionMeta}>{text.source}</span>
        <a href={item.sourceUrl} target="_blank" rel="noreferrer">{text.openInBrowser}</a>
      </div>
      <div className={css.communityReadme}>
        {readme.loading ? <p className={css.loading}>{text.readmeLoading}</p> : null}
        {!readme.loading && readme.text !== undefined ? <>{language === 'zh' && readme.localized ? <p className={css.sectionMeta}>{text.readmeChinese}</p> : null}<pre>{readme.text}</pre></> : null}
        {!readme.loading && readme.text === undefined ? <p className={css.sectionMeta}>{readme.error === 'unreadable' ? text.readmeError : text.readmeEmpty}</p> : null}
      </div>
      <footer className={css.communityModalFooter}>
        {onInstall === undefined ? null : <button className={css.button} type="button" disabled={busy || item.installed || !item.installable} onClick={onInstall}>{installLabel}</button>}
        <button className={css.button} type="button" onClick={onClose}>{text.close}</button>
      </footer>
    </article>
  </div>
}
