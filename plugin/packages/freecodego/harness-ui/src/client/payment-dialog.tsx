/**
 * In-plugin payment: the card form and the scan surface, inside the panel.
 *
 * Why this exists
 * ---------------
 * The panel used to hand the checkout URL to the browser. That page is the
 * backend's own console mount (`/rootadmin/payment/stripe?...`), which is the
 * wrong place for a customer twice over: the console is not meant for users, and
 * it cannot be shown here anyway — `freecodego.com` answers with
 * `X-Frame-Options: DENY` and CSP `frame-ancestors 'none'`, so no iframe or
 * dialog can ever render it.
 *
 * So the card form is Stripe's own Payment Element, mounted in this dialog and
 * driven by two values the checkout already has: the order's `client_secret` and
 * the **publishable** key the desktop payment config publishes. Card data goes
 * from this page straight to Stripe; it never touches the Harness host, and the
 * secret key never crosses the boundary.
 *
 * Scan-to-pay providers (Alipay / WeChat through 易支付) come back as a QR code
 * or a `pay_url`. A QR needs no third-party page at all — the phone pays — which
 * is why it is the primary surface and the page is the fallback.
 *
 * @module client/payment-dialog
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatMoney } from './money-format.ts'
import css from './settings-tab.module.css'

/** The order fields this dialog renders; a structural subset of the panel's. */
export interface PaymentDialogOrder {
  readonly orderId: string
  readonly state: string
  readonly amount: number
  readonly currency?: string
  readonly payAmount?: number
  readonly paymentType?: string
  readonly clientSecret?: string
  readonly qrCode?: string
  readonly checkoutUrl?: string
}

/** Minimal Stripe.js surface: only what the dialog calls, so no SDK is needed. */
interface StripeElement {
  mount(target: HTMLElement): void
  destroy(): void
  /** Stripe.js reports a blocked or failed inner iframe here, not by throwing. */
  on?(event: 'loaderror', handler: (event: { error?: { message?: string } }) => void): void
}
interface StripeElements {
  create(type: 'payment', options?: Record<string, unknown>): StripeElement
}

/** Surface Stripe's own iframe-load failure through the same channel as a throw. */
function mountFailureWatch(element: StripeElement, report: (error: unknown) => void): void {
  element.on?.('loaderror', (event) => { report(event.error?.message ?? 'The card form could not be loaded (its frame was blocked or unreachable).') })
}

/**
 * Release the Element the dialog mounted.
 *
 * `destroy()` is what releases Stripe's iframe and its listeners; emptying the
 * host does not, so a dialog that only emptied it left one behind per open — and
 * this panel is opened far more often than it is reloaded. The sweep is for the
 * stub Element the specs build, which carries no `destroy` to call.
 */
function destroyElement(element: StripeElement | undefined, host: HTMLElement | null): void {
  try { element?.destroy() } catch { for (const child of host?.children ?? []) child.remove?.() }
}
interface StripeInstance {
  elements(options: { clientSecret: string; appearance?: Record<string, unknown> }): StripeElements
  // `type` is what separates a message written for the cardholder from one
  // written for a developer: see `stripeConfirmCopy`.
  confirmPayment(options: Record<string, unknown>): Promise<{ error?: { message?: string; type?: string; code?: string } }>
}
type StripeFactory = (publishableKey: string) => StripeInstance

const STRIPE_JS_URL = 'https://js.stripe.com/v3/'
let stripeJsPromise: Promise<StripeFactory> | undefined

/** Why the card form itself could not be put on screen. */
type CardFormLoadReason = 'no-document' | 'factory-missing' | 'script-blocked'

/**
 * Mark a loader failure with what went wrong, without saying it in the message.
 *
 * The message is the developer's sentence and stays one: it is logged, never
 * printed. It used to be printed, which handed the customer
 * `Stripe.js loaded without exposing the Stripe factory` — our plumbing, in a
 * sentence nobody outside this file can act on. `reason` is the half the dialog
 * can word, and it travels beside the message so the two cannot drift.
 */
function cardFormLoadError(reason: CardFormLoadReason, detail: string): Error {
  const error = new Error(detail)
  ;(error as { cardFormReason?: CardFormLoadReason }).cardFormReason = reason
  return error
}

/**
 * What to print for a card form that could not be drawn.
 *
 * Only two outcomes are worth telling apart. `script-blocked` is the one a
 * customer can act on — the page never fetched the payment script, which a
 * network, a proxy or a content blocker explains. Everything else (a session the
 * processor refused, a factory the script never exposed, a frame that never
 * arrived) is answered with one sentence, because the difference is ours to
 * investigate rather than theirs to fix. The full failure is logged either way:
 * this dialog is the only place it surfaces, so the log is where the developer's
 * half of it belongs.
 */
export function describeCardFormFailure(cause: unknown, zh: boolean): string {
  const reason = typeof cause === 'object' && cause !== null ? (cause as { cardFormReason?: CardFormLoadReason }).cardFormReason : undefined
  console.warn('[freecodego] card form unavailable', cause)
  return reason === 'script-blocked'
    ? (zh ? '支付组件加载失败，请检查网络、代理或内容拦截器后重试。' : 'The payment form could not be loaded; check the network, a proxy or a content blocker and try again.')
    : (zh ? '支付表单暂时无法显示，请稍后重试或改用其他支付方式。' : 'The payment form cannot be shown right now; try again later or use another payment method.')
}

/**
 * What to print when `confirmPayment` answers with an error.
 *
 * The processor's `card_error` and `validation_error` messages are addressed to
 * whoever holds the card ("Your card was declined.") and are the only account of
 * *why* the payment failed, so replacing them with a generic line would take
 * away the one thing the customer can act on. Its request-level failures are not
 * that — an expired session or a rejected key reads as our own stack — so those
 * are logged and worded like every other form failure.
 */
function stripeConfirmCopy(error: { message?: string; type?: string }, zh: boolean): string {
  const cardholderFacing = error.type === 'card_error' || error.type === 'validation_error'
  const message = error.message?.trim() ?? ''
  return cardholderFacing && message !== '' ? message : describeCardFormFailure(error, zh)
}

/**
 * Load Stripe.js once per page.
 *
 * Cached at module scope on purpose: re-injecting the script for a second
 * payment would replace the global `Stripe` while the first dialog still holds a
 * reference to the old factory, which is how a mounted Element loses its
 * instance. The promise is cached rather than the resolved value so that two
 * simultaneous dialogs share one injection.
 */
export function loadStripeJs(): Promise<StripeFactory> {
  stripeJsPromise ??= new Promise<StripeFactory>((resolve, reject) => {
    const existing = (globalThis as { Stripe?: StripeFactory }).Stripe
    if (existing !== undefined) { resolve(existing); return }
    if (typeof document === 'undefined') { reject(cardFormLoadError('no-document', 'Stripe.js requires a browser document')); return }
    const script = document.createElement('script')
    script.src = STRIPE_JS_URL
    script.async = true
    script.onload = () => {
      const factory = (globalThis as { Stripe?: StripeFactory }).Stripe
      if (factory === undefined) reject(cardFormLoadError('factory-missing', 'Stripe.js loaded without exposing the Stripe factory'))
      else resolve(factory)
    }
    script.onerror = () => { reject(cardFormLoadError('script-blocked', 'Stripe.js could not be loaded; check the network or any content blocker')) }
    document.head.appendChild(script)
  })
  return stripeJsPromise
}

/** Drop the cached loader; only for tests that need a fresh injection. */
export function resetStripeJsCacheForTests(): void { stripeJsPromise = undefined }

/** Order states that mean the money arrived, per the backend's own spellings. */
const PAID_STATES: ReadonlySet<string> = new Set(['paid', 'completed', 'success', 'settled', 'finished'])

export function isPaidOrderState(state: string): boolean {
  return PAID_STATES.has(state.trim().toLowerCase())
}

/** Whether the payment of the order this guard belongs to has been announced. */
interface PaidAnnouncement { readonly orderId: string; readonly announced: boolean }

/**
 * Claim the right to announce this order's payment; true at most once per order.
 *
 * The guard is kept *with the order id it was claimed for* rather than as a bare
 * flag. Two things follow, and both are the point: a read that carries `paid`
 * again — the first poll of an order that arrived already settled, a parent
 * re-render, a settings change — stays silent, because the callback reloads the
 * entire account; and a second order under the same dialog still announces its
 * own payment, which a flag cleared when the dialog reopens would swallow.
 */
function claimPaidAnnouncement(guard: { current: PaidAnnouncement }, orderId: string, state: string): boolean {
  if (!isPaidOrderState(state)) return false
  if (guard.current.orderId === orderId && guard.current.announced) return false
  guard.current = { orderId, announced: true }
  return true
}

/** How the dialog can complete this order, in the order of preference. */
export type PaymentFlow = 'stripe' | 'qr' | 'link' | 'unavailable'

/**
 * Choose the surface for an order.
 *
 * A card session is preferred whenever both halves are present, because the card
 * form is the one path that needs no third-party page. A QR second, since the
 * phone does the paying. A link last, and only when the backend actually sent
 * one. `unavailable` is a real answer: an order with neither a client secret, a
 * QR, nor a URL cannot be paid from here, and the dialog says which piece is
 * missing instead of rendering an empty box.
 */
/** A publishable key, by Stripe's own prefix. Anything else cannot initialise
 * Stripe.js, so offering a card form for it would fail in front of the user. */
const PUBLISHABLE_KEY_PATTERN = /^pk_(?:test|live)_[A-Za-z0-9]{8,}$/u

export function paymentFlow(order: Pick<PaymentDialogOrder, 'clientSecret' | 'qrCode' | 'checkoutUrl'>, publishableKey: string | undefined): PaymentFlow {
  const usableKey = publishableKey !== undefined && PUBLISHABLE_KEY_PATTERN.test(publishableKey.trim())
  if (order.clientSecret !== undefined && order.clientSecret.trim() !== '' && usableKey) return 'stripe'
  if (order.qrCode !== undefined && order.qrCode.trim() !== '') return 'qr'
  if (order.checkoutUrl !== undefined && order.checkoutUrl.trim() !== '') return 'link'
  return 'unavailable'
}

const QR_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif|avif|svg\+xml);base64,[a-z0-9+/=]+$/i

/**
 * Whether the QR payload is an image or a string to be encoded.
 *
 * 易支付 returns both shapes across channels: a rendered PNG for some, and the
 * payment URL itself for others. The string form is shown verbatim with a copy
 * action, because drawing a QR from an arbitrary string needs an encoder this
 * build does not carry — and a wrong QR is worse than a readable URL.
 */
export function qrPayloadKind(value: string): 'image' | 'link' | 'text' {
  if (QR_IMAGE_PATTERN.test(value.trim())) return 'image'
  return /^https?:\/\//i.test(value.trim()) ? 'link' : 'text'
}

/**
 * The only checkout URLs this client will render as a link.
 *
 * Its job is to keep a malformed or hostile URL out of an anchor: no cleartext,
 * no embedded credentials, and nothing under the console mount except the public
 * payment routes themselves. The console hosts both the payment routes and the
 * administrator-only order pages, so the guard is the *payment* routes —
 * blocking the whole mount rejected legitimate same-site handoffs and reported
 * "no usable redirect" for an order that had one.
 */
export function safeCheckoutUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  if (url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  if (url.hostname === 'freecodego.com' && /^\/rootadmin\/payment\/(?:result|stripe|stripe-popup|airwallex|paypal)(?:\/|$)/i.test(url.pathname)) return url.toString()
  if (url.hostname === 'freecodego.com' && /^\/rootadmin(?:\/|$)/i.test(url.pathname)) return undefined
  return url.toString()
}

/**
 * Re-express one CSS colour in the forms Stripe's own parser accepts.
 *
 * Stripe themes the Element from these literals, and its parser is stricter than
 * a browser's: an 8-digit hex — `#0000001a`, which is exactly what this panel's
 * `--fcg-line` resolves to — is **rejected**, and a rejected appearance is
 * discarded *silently*. Stripe then falls back to its own default theme, which
 * follows the operating system, so a dark-mode machine drew a black card form
 * inside this light dialog. Handing over `rgba()` instead is what actually keeps
 * the Element on the panel's palette, which is the whole point of reading these
 * variables rather than picking a theme.
 */
export function stripeColor(value: string, fallback: string): string {
  const input = value.trim().toLowerCase()
  if (input === '') return fallback
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(input)?.[1]
  if (hex === undefined) {
    if (/^(?:rgb|rgba|hsl|hsla|color)\(/.test(input)) return input
    // Named colours (`transparent`, `white`, …) are valid CSS and valid to
    // Stripe; anything else is unrecognised and falls back rather than risking
    // the whole appearance object being dropped.
    if (/^[a-z]+$/.test(input)) return input
    return fallback
  }
  const wide = hex.length <= 4 ? Array.from(hex).map(character => character + character).join('') : hex
  const channel = (offset: number): number => Number.parseInt(wide.slice(offset, offset + 2), 16)
  const alpha = wide.length === 8 ? Math.round(Number.parseInt(wide.slice(6, 8), 16) / 255 * 100) / 100 : 1
  const parts = `${channel(0)}, ${channel(2)}, ${channel(4)}`
  return alpha >= 1 ? `rgb(${parts})` : `rgba(${parts}, ${alpha})`
}

/**
 * The Element's palette, read off the dialog's own colours.
 *
 * Stripe renders the form in an iframe of its own, which cannot see our CSS
 * variables, so the resolved values are handed over as literals. Everything is a
 * fallback, so a host with no theme still renders, and every colour is
 * normalised by {@link stripeColor} so Stripe never quietly drops the lot.
 */
export function stripeAppearanceOf(host: HTMLElement | null): Record<string, unknown> {
  const read = (name: string, fallback: string): string => {
    if (host === null || typeof globalThis.getComputedStyle !== 'function') return fallback
    const value = globalThis.getComputedStyle(host).getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  const color = (name: string, fallback: string): string => stripeColor(read(name, fallback), fallback)
  // The modal card itself is layer-2, so the Element has to be layer-2 as well:
  // "same colour" is the whole point of reading these instead of picking a theme.
  const background = color('--fcg-bg-layer-2', '#ffffff')
  const surface = color('--fcg-bg-input', read('--fcg-bg-tip', '') === '' ? background : read('--fcg-bg-tip', background))
  const text = color('--fcg-text-primary', '#101828')
  const muted = color('--fcg-text-tertiary', '#667085')
  // Field labels carry the meaning of the box under them, so they get the
  // secondary token rather than the tertiary one: at 12px the tertiary colour
  // sat too close to the white card to read as a label at all.
  const label = color('--fcg-text-secondary', '#475467')
  const line = color('--fcg-line', '#e4e7ec')
  const brand = color('--fcg-brand', '#3b82f6')
  const danger = color('--fcg-danger', '#d92d20')
  return {
    theme: 'flat',
    variables: {
      colorPrimary: brand,
      colorBackground: background,
      colorText: text,
      colorTextSecondary: label,
      colorTextPlaceholder: muted,
      colorDanger: danger,
      borderRadius: '10px',
      fontSizeBase: '14px',
      spacingUnit: '4px',
    },
    rules: {
      '.Input': { backgroundColor: surface, border: `1px solid ${line}`, boxShadow: 'none', color: text },
      '.Input:focus': { border: `1px solid ${brand}`, boxShadow: 'none' },
      '.Label': { color: label, fontSize: '12px', marginBottom: '4px' },
      '.Tab': { backgroundColor: surface, border: `1px solid ${line}`, boxShadow: 'none' },
      '.Tab--selected': { backgroundColor: background, borderColor: brand, color: text },
    },
  }
}

/**
 * What the card form should ask for, given what the account already told us.
 *
 * A signed-in buyer has an address on the account — Stripe is handed it as
 * `receipt_email`, and the invoice (and its PDF) is mailed there — so the form
 * itself has nothing left to ask: no name, phone, address, or email field. That
 * is both the compact dialog the panel wants and the one honest answer, because
 * an independently typed address would be a second, unverified copy of the same
 * fact. Without a known address the email field stays, since the invoice needs
 * somewhere to go.
 */
export function stripeFieldOptions(receiptEmail: string | undefined): Record<string, unknown> {
  if (receiptEmail !== undefined && receiptEmail.trim() !== '') return { billingDetails: 'never' }
  return { billingDetails: { name: 'never', phone: 'never', address: 'never' } }
}

/**
 * The backend's order states, said in the reader's language.
 *
 * Shared with the receipt list rather than kept private: the dialog and the list
 * render the same vocabulary, and two tables would eventually disagree about one
 * state — which is the kind of disagreement a payer reads as a contradiction.
 * A state the table does not know is printed as the backend spelled it, so an
 * unknown token still reaches the reader instead of being swallowed.
 *
 * It maps the backend's vocabulary, not this product's offer: `refunded` has a
 * spelling here even though this product sells no refunds and never requests the
 * refund family, because the dialog renders whatever state the backend reports
 * for an order. An admin refund (`POST /api/v1/admin/payment/orders/:id/refund`)
 * is the one way such a row can exist, and a mapping that omitted it would print
 * a raw `REFUNDED` at the reader instead.
 */
export function orderStateLabel(state: string, zh: boolean): string {
  const table: Record<string, readonly [string, string]> = {
    pending: ['待支付', 'Awaiting payment'],
    paid: ['已支付', 'Paid'],
    // The middle of the lifecycle this panel asks for (`paid` → `recharging` →
    // `completed`): the money arrived and the credits are being applied. It was
    // the one state the table did not know while the order list requested it, so
    // an order being credited printed a raw `RECHARGING`.
    recharging: ['额度到账中', 'Applying credit'],
    completed: ['已完成', 'Completed'],
    success: ['已支付', 'Paid'],
    settled: ['已结算', 'Settled'],
    cancelled: ['已取消', 'Cancelled'],
    canceled: ['已取消', 'Cancelled'],
    expired: ['已过期', 'Expired'],
    refunded: ['已退款', 'Refunded'],
    failed: ['失败', 'Failed'],
  }
  const found = table[state.trim().toLowerCase()]
  if (found === undefined) return state.trim()
  return zh ? found[0] : found[1]
}

interface PaymentDialogProps {
  readonly open: boolean
  readonly order: PaymentDialogOrder
  readonly publishableKey: string | undefined
  /** Currency of the pay amount, resolved by the panel from its channel table. */
  readonly payCurrency: string | undefined
  readonly language: 'zh' | 'en'
  readonly returnUrl: string
  /**
   * The signed-in account email. Stripe sends its own receipt (and the invoice
   * PDF) to this address once the card payment succeeds, which is what makes an
   * invoice reachable *after* payment without a console page.
   */
  readonly receiptEmail?: string
  /** Re-read the order; `undefined` means the read failed. */
  readonly loadOrder: (orderId: string) => Promise<PaymentDialogOrder | undefined>
  /** Called once when the order reaches a paid state. */
  readonly onPaid: () => void
  /** Save this order's receipt; offered only once the order is paid. */
  readonly onDownloadReceipt?: (() => void) | undefined
  readonly onCancelOrder: (() => void) | undefined
  readonly onClose: () => void
}

/**
 * The payment surface itself: heading, Stripe Element or QR, and the live state.
 *
 * The dialog owns two things the panel cannot: the Stripe Element instance
 * (which must be destroyed with the dialog) and the polling loop that turns "the
 * user says they paid" into "the backend agrees".
 */
export function PaymentDialog(props: PaymentDialogProps): ReactNode {
  const { open, order, publishableKey, payCurrency, language, returnUrl, receiptEmail, loadOrder, onPaid, onDownloadReceipt, onCancelOrder, onClose } = props
  const zh = language === 'zh'
  // The flow is chosen from the *sanitized* URL: a provider URL this client will
  // not render as a link must not make the dialog claim it has one. The input is
  // built key by key because this package compiles with
  // `exactOptionalPropertyTypes`, where an explicit `undefined` is not the same
  // as an absent field.
  const linkUrl = safeCheckoutUrl(order.checkoutUrl)
  const flow = paymentFlow({
    ...(order.clientSecret === undefined ? {} : { clientSecret: order.clientSecret }),
    ...(order.qrCode === undefined ? {} : { qrCode: order.qrCode }),
    ...(linkUrl === undefined ? {} : { checkoutUrl: linkUrl }),
  }, publishableKey)
  const [stripeError, setStripeError] = useState<string | undefined>(undefined)
  const [confirming, setConfirming] = useState(false)
  const [liveState, setLiveState] = useState(order.state)
  const elementHost = useRef<HTMLDivElement | null>(null)
  const elementRef = useRef<StripeElement | undefined>(undefined)
  const elementsRef = useRef<StripeElements | undefined>(undefined)
  const stripeRef = useRef<StripeInstance | undefined>(undefined)
  const paidRef = useRef<PaidAnnouncement>({ orderId: order.orderId, announced: false })
  // The poll calls these, but must not restart when the panel re-renders: a new
  // callback identity on every parent render would tear down and re-fire the
  // interval, and each poll writes state — a loop that reads the order as fast
  // as the network allows. Keeping them in refs leaves the interval's identity
  // tied to the order it is watching, which is the only thing that changes it.
  const loadOrderRef = useRef(loadOrder)
  const onPaidRef = useRef(onPaid)
  useEffect(() => { loadOrderRef.current = loadOrder; onPaidRef.current = onPaid })

  // Mount the Payment Element while the dialog owns a card session.
  useEffect(() => {
    if (!open || flow !== 'stripe' || order.clientSecret === undefined) return
    let disposed = false
    const host = elementHost.current
    if (host === null) return
    setStripeError(undefined)
    // Every failure in here has to reach the user. Creating an Element can throw
    // (a rejected key, a session Stripe refuses), and `.on('loaderror')` fires
    // when Stripe's own iframe cannot be fetched — e.g. blocked by an extension
    // or a corporate network. Left unhandled, both of those render an empty box
    // that looks like a loading state forever, which is the one outcome the
    // dialog must never produce.
    const report = (error: unknown): void => { if (!disposed) setStripeError(describeCardFormFailure(error, zh)) }
    void loadStripeJs().then((factory) => {
      if (disposed || elementHost.current === null) return
      try {
        const stripe = factory(publishableKey ?? '')
        const elements = stripe.elements({
          clientSecret: order.clientSecret ?? '',
          appearance: stripeAppearanceOf(elementHost.current),
        })
        // `link: 'never'` drops Stripe's saved-account product, which otherwise
        // appends a second form under the card ("save my info" with email, phone
        // and full name). Those details are not needed to pay once here, and the
        // extra block made the dialog tall enough to push the pay button out of
        // view.
        const element = elements.create('payment', {
          wallets: { link: 'never' },
          // One payment method renders as one collapsing row instead of an open
          // section per method; the dialog is a payment step, not a catalogue.
          layout: { type: 'accordion', defaultCollapseWhenAvailable: true, radios: false, spacedAccordionItems: false },
          fields: stripeFieldOptions(receiptEmail),
        })
        mountFailureWatch(element, report)
        element.mount(elementHost.current)
        stripeRef.current = stripe
        elementsRef.current = elements
        // Held so the cleanup can destroy it: the Element cannot be reached
        // from `elements`, and recreating it per mount is exactly what leaks.
        elementRef.current = element
      } catch (error) { report(error) }
    }, report).catch(report)
    return () => {
      disposed = true
      const element = elementRef.current
      elementRef.current = undefined
      elementsRef.current = undefined
      stripeRef.current = undefined
      destroyElement(element, elementHost.current)
    }
  }, [open, flow, order.clientSecret, publishableKey, receiptEmail])

  // Keep the rendered state in step with the order the panel holds.
  useEffect(() => { setLiveState(order.state) }, [order.state])

  // Announce a paid order exactly once per order. The guard is bound to the
  // order it was claimed for, not to every state change: the panel reloads the
  // whole account on this callback, and a render that happens to carry `paid`
  // again (another poll, a settings change, a parent re-render) must not reload
  // it a second time.
  useEffect(() => {
    if (!open) return
    if (claimPaidAnnouncement(paidRef, order.orderId, order.state)) onPaidRef.current()
  }, [open, order.orderId, order.state])

  // Poll the backend while the dialog is open: the payment happens elsewhere
  // (Stripe, or the user's phone), so the panel cannot be told — it has to ask.
  useEffect(() => {
    if (!open) return
    let stopped = false
    const tick = async (): Promise<void> => {
      const latest = await loadOrderRef.current(order.orderId)
      if (stopped || latest === undefined) return
      setLiveState(latest.state)
      // The first read of an order the panel handed over already settled is not
      // a second payment: it has been announced, so this stays silent.
      if (claimPaidAnnouncement(paidRef, order.orderId, latest.state)) onPaidRef.current()
    }
    const timer = setInterval(() => { void tick() }, 4_000)
    void tick()
    return () => { stopped = true; clearInterval(timer) }
  }, [open, order.orderId])

  const confirm = (): void => {
    const stripe = stripeRef.current
    const elements = elementsRef.current
    if (stripe === undefined || elements === undefined) {
      setStripeError(zh ? '卡支付组件还没准备好，请稍候再试。' : 'The card form is not ready yet; try again in a moment.')
      return
    }
    setConfirming(true)
    setStripeError(undefined)
    void stripe.confirmPayment({
      elements,
      // `if_required` keeps a frictionless card inside the dialog: only a flow
      // that genuinely needs the bank (3DS, wallet redirect) leaves for
      // `returnUrl`, which is the backend's own canonical result page.
      redirect: 'if_required',
      confirmParams: {
        return_url: returnUrl,
        // The receipt (and, with invoice creation on the backend, the invoice) is
        // delivered by Stripe to this address. Sent only when we actually know
        // it — an invented address would mail someone else's receipt.
        ...(receiptEmail === undefined || receiptEmail.trim() === '' ? {} : { receipt_email: receiptEmail.trim() }),
      },
    }).then((result) => {
      if (result.error !== undefined) {
        setStripeError(stripeConfirmCopy(result.error, zh))
        return
      }
      void loadOrderRef.current(order.orderId).then((latest) => {
        if (latest === undefined) return
        setLiveState(latest.state)
        if (claimPaidAnnouncement(paidRef, order.orderId, latest.state)) onPaidRef.current()
      }, () => undefined)
    }, (error: unknown) => { setStripeError(describeCardFormFailure(error, zh)) }).finally(() => { setConfirming(false) })
  }

  const qr = order.qrCode?.trim() ?? ''
  const qrKind = qr === '' ? undefined : qrPayloadKind(qr)
  const paid = isPaidOrderState(liveState)

  return <Modal
    open={open}
    onClose={onClose}
    title={zh ? '完成支付' : 'Complete payment'}
    closeLabel={zh ? '关闭' : 'Close'}
    className={css.payDialog ?? ''}
    footer={<div className={css.payDialogFooter}>
      {flow === 'stripe' ? <button className={`${css.button} ${css.buttonPrimary}`} type="button" onClick={confirm} disabled={confirming || paid}>{confirming ? (zh ? '支付中…' : 'Paying…') : (zh ? '确认支付' : 'Pay now')}</button> : null}
      {/* The receipt appears with the payment, not before it: the backend only
          has a document to serve once the order settled. */}
      {paid && onDownloadReceipt !== undefined ? <button className={css.button} type="button" onClick={onDownloadReceipt}>{zh ? '下载收据' : 'Download receipt'}</button> : null}
      {onCancelOrder === undefined || paid ? null : <button className={`${css.button} ${css.buttonDanger}`} type="button" onClick={onCancelOrder}>{zh ? '取消订单' : 'Cancel order'}</button>}
      <button className={css.button} type="button" onClick={onClose}>{zh ? '关闭' : 'Close'}</button>
    </div>}
  >
    <div className={css.payDialogBody}>
      {/* What the payer needs is the number they are about to pay and what it
          buys. The order id, its internal state spelling, and our polling
          cadence are ours, not theirs — they moved to the footer line only when
          something is actually wrong (a cancelled, expired or failed order). */}
      <div className={css.payDialogHead}>
        <small className={css.payDialogLabel}>{zh ? '应付金额' : 'Amount due'}</small>
        {/* The amount due goes through the same formatter the panel quoted it
            with, so the number on this line is the number that will be charged:
            it used to clamp to two decimals while the quote rounded to the
            currency's own minor unit, and a payer reading "2.01" beside an
            order that settles 2.012 has not been told what they are paying. */}
        <strong className={css.payDialogAmount}>{formatMoney(order.payAmount ?? order.amount, order.payAmount === undefined ? 'USD' : (payCurrency ?? order.currency))}</strong>
        <div className={css.payDialogMeta}>
          <span className={css.payDialogCredit}>{zh ? '到账额度' : 'You receive'} <strong>{formatMoney(order.amount, 'USD')}</strong></span>
          {paid ? null : <span className={css.payDialogState}>{orderStateLabel(liveState, zh)}</span>}
        </div>
      </div>

      {paid ? <div className={css.payDialogPaid} role="status">{zh ? '支付已完成，额度已到账。' : 'Payment received; the credit has been applied.'}</div> : null}
      {paid && receiptEmail !== undefined && receiptEmail.trim() !== '' ? <small className={css.sectionMeta}>{zh
        ? `付款凭证已发送至 ${receiptEmail.trim()}，也可用下方按钮直接下载收据。`
        : `The payment documentation went to ${receiptEmail.trim()}; you can also download the receipt below.`}</small> : null}

      {flow === 'stripe' ? <div className={css.payDialogSlot}>
        <div className={css.payDialogElement} ref={elementHost} />
        {stripeError === undefined ? null : <div className={css.paymentNotice} role="alert">{stripeError}</div>}
      </div> : null}

      {flow === 'qr' ? <div className={`${css.payDialogSlot} ${css.payDialogQr}`}>
        <small className={css.sectionMeta}>{zh ? '用支付宝 / 微信扫码完成付款，付款后本窗口会自动更新。' : 'Scan with Alipay or WeChat; this window updates itself once paid.'}</small>
        {qrKind === 'image'
          ? <img className={css.qr} src={qr} alt={zh ? '支付二维码' : 'Payment QR code'} />
          : <div className={css.qrWrap}><code className={css.qrText}>{qr}</code><button className={css.button} type="button" onClick={() => { void globalThis.navigator?.clipboard?.writeText(qr) }}>{zh ? '复制支付链接' : 'Copy payment link'}</button></div>}
      </div> : null}

      {flow === 'stripe' ? <small className={css.sectionMeta}>{zh
        ? '支持 Visa / Mastercard / American Express / JCB / Discover 等国际信用卡；卡号在传输中加密，本机不留存。'
        : 'Visa, Mastercard, American Express, JCB and Discover are accepted; the card number is encrypted in transit and is never stored here.'}</small> : null}

      {/* The mainland-only wallet channels reject overseas exits, so this note
          belongs to them. The card channel has no such restriction, and repeating
          it there would send people to turn off a proxy that is not the problem. */}
      {paid || flow === 'stripe' ? null : <small className={css.payDialogNote}>{zh
        ? '支付成功即刻到账；若长时间无法完成，请先关闭代理或 VPN 后重试，或改用银行卡支付。'
        : 'Credit is applied as soon as the payment succeeds. If it will not go through, turn off any proxy or VPN and retry, or pay by card.'}</small>}

      {flow === 'link' ? <div className={css.payDialogSlot}>
        <small className={css.sectionMeta}>{zh ? '该通道只返回了支付页地址。若你在海外或开着代理，支付页可能拒绝访问；中国大陆网络下通常可以正常打开。' : 'This channel returned a payment page URL only. Overseas traffic or a proxy may be refused by that page; a mainland China network usually opens it.'}</small>
        <a className={css.button} href={linkUrl} target="_blank" rel="noreferrer">{zh ? '在浏览器打开支付页' : 'Open the payment page'}</a>
      </div> : null}

      {flow === 'unavailable' ? <div className={css.paymentNotice} role="alert">{zh
        ? '这笔订单暂时没有可用的支付方式：没有卡支付表单、二维码或支付页地址。请重新打开订单后再试，或换一种支付方式。'
        : 'Nothing here can take the payment yet — no card form, no QR code and no payment link. Reopen the order and try again, or use another payment method.'}</div> : null}
    </div>
  </Modal>
}
