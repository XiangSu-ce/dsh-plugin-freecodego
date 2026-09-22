/**
 * The machinery for taking over elements the shell renders itself.
 *
 * Some of the FreeCodeGo surface cannot be a Slot: the elements live inside
 * another plugin's React tree with no extension point on them (the Chat view's
 * turn-status row, the transcript's running rows). Where that is the case the
 * character is *injected* into the shipped element and only its animation is
 * replaced — see `./running-row.tsx` and `./step-row.tsx`, the two callers.
 *
 * What a caller owns is the site: its selector, the marker its stylesheet keys on,
 * what it mounts, and what "release" means for it. What this module owns is the
 * lifecycle, and it is one lifecycle for every site:
 *
 * - **One pass per frame.** A Chat view mounts as a burst of childList mutations,
 *   so a pass is coalesced onto an animation frame rather than run per mutation,
 *   and a pass queued at dispose is cancelled rather than run against a detached
 *   document.
 * - **A marker element is taken over once.** A caller marks what it took over
 *   (its own attribute, which its stylesheet also uses), and the marker is the
 *   repeat guard: a re-scan never mounts a second copy into the same element.
 * - **The element's lifetime is the injection's.** An element that leaves the
 *   document releases its injection, which is what makes "the turn ended" and
 *   "the row went away" the same event here.
 */
/** One site of injection. */
export interface TakeoverOptions {
  /** Elements to take over. Matched on every pass, in document order. */
  readonly selector: string
  /** Marker attribute a taken-over element carries; also the repeat guard. */
  readonly mark: string
  /**
   * Take one matched element over.
   *
   * Called once per element, with the element already free of the marker: a site
   * that finds nothing it can decorate returns a no-op teardown rather than
   * marking the element, so a later pass can still take it.
   * @param element - the matched element.
   * @returns the element's teardown, run when it leaves the document or the
   * plugin is disposed.
   */
  readonly takeOver: (element: HTMLElement) => () => void
}

/**
 * Watch the document and keep every match taken over.
 * @param options - the site to watch and how to take it over.
 * @returns a disposer that stops watching and releases every injection.
 */
export function installTakeover(options: TakeoverOptions): () => void {
  const taken = new Map<HTMLElement, () => void>()

  const pass = (): void => {
    for (const [element, release] of [...taken]) {
      if (element.isConnected) continue
      taken.delete(element)
      release()
    }
    for (const element of document.querySelectorAll<HTMLElement>(options.selector)) {
      if (taken.has(element) || element.hasAttribute(options.mark)) continue
      taken.set(element, options.takeOver(element))
    }
  }

  pass()
  let frame: number | undefined
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = window.requestAnimationFrame(() => {
      frame = undefined
      pass()
    })
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    for (const release of taken.values()) release()
    taken.clear()
  }
}

/**
 * Inject one site's stylesheet, once per document.
 * @param styleAttr - marker attribute naming this site's sheet.
 * @param css - the sheet's text.
 */
export function ensureTakeoverStyle(styleAttr: string, css: string): void {
  if (document.head.querySelector(`[${styleAttr}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(styleAttr, 'true')
  style.textContent = css
  document.head.append(style)
}

/**
 * Mount a container into an element and render the face into it.
 *
 * The container is *prepended*, so it is the element's first child: what the
 * shell renders after it (a clock, a title, a chevron) stays where React put it,
 * and React is never asked to insert around a foreign child it did not create.
 * @param element - the taken-over element.
 * @param attr - marker attribute the container carries.
 * @param className - the container's class, as its stylesheet spells it.
 * @param mount - render the face into the container; returns its unmount.
 * @returns the teardown for this element.
 */
export function prependFace(
  element: HTMLElement,
  attr: string,
  className: string,
  mount: (container: HTMLElement) => () => void,
): () => void {
  const container = document.createElement('div')
  container.className = className
  container.setAttribute(attr, 'true')
  element.prepend(container)
  const unmount = mount(container)
  return () => {
    unmount()
    container.remove()
  }
}
