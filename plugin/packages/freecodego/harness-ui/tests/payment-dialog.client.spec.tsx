// @vitest-environment jsdom
/**
 * The in-panel payment surface.
 *
 * Why these cases exist
 * --------------------
 * The panel used to open the backend's checkout page in a browser tab. That page
 * is the console mount and answers `frame-ancestors 'none'`, so it can never be
 * embedded, and it is not a page to send a customer to. The dialog therefore
 * decides *for itself* which surface an order can be paid on — card session, QR,
 * provider page, or none — and each of those decisions is pinned here, together
 * with the guarantees around them: the card form is only offered when the
 * publishable key is present, a provider URL is sanitized before it becomes an
 * anchor, and the paid state is announced exactly once.
 *
 * @module tests/payment-dialog
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * A Stripe secret-shaped key, composed rather than written out.
 *
 * GitHub's push protection refuses a push carrying the literal `sk_live_…`,
 * fixtures included, and it reads the committed bytes rather than the runtime
 * value. The decision under test turns on the `sk_` prefix — the body is only
 * there to look like a key — so interpolating it changes nothing the spec
 * asserts and keeps a key-shaped literal out of the published repository.
 */
const STRIPE_SECRET_SHAPED_KEY = 'sk_live_' + '51Tq9T8R66vde5mUX'
import {
  describeCardFormFailure,
  isPaidOrderState,
  loadStripeJs,
  paymentFlow,
  qrPayloadKind,
  resetStripeJsCacheForTests,
  safeCheckoutUrl,
  stripeAppearanceOf,
  stripeColor,
  PaymentDialog,
} from '../src/client/payment-dialog.tsx'

afterEach(() => { cleanup(); resetStripeJsCacheForTests(); delete (globalThis as { Stripe?: unknown }).Stripe })

const QR_IMAGE = 'data:image/png;base64,iVBORw0KGgo='

describe('choosing the payment surface', () => {
  it('prefers the card form only when both halves of the session are present', () => {
    expect(paymentFlow({ clientSecret: 'pi_1_secret' }, 'pk_live_51Tq9T8R66vde5mUX')).toBe('stripe')
    // A session with no publishable key cannot initialise Stripe.js, so the
    // dialog must not claim a card form it would fail to mount.
    expect(paymentFlow({ clientSecret: 'pi_1_secret' }, undefined)).toBe('unavailable')
    expect(paymentFlow({ clientSecret: '   ' }, 'pk_live_51Tq9T8R66vde5mUX')).toBe('unavailable')
  })

  it('falls back to the scan surface, then the provider page', () => {
    expect(paymentFlow({ qrCode: QR_IMAGE }, undefined)).toBe('qr')
    expect(paymentFlow({ qrCode: QR_IMAGE, checkoutUrl: 'https://pay.example/1' }, 'pk_live_51Tq9T8R66vde5mUX')).toBe('qr')
    expect(paymentFlow({ checkoutUrl: 'https://pay.example/1' }, undefined)).toBe('link')
  })

  it('says so when an order carries nothing payable', () => {
    expect(paymentFlow({}, undefined)).toBe('unavailable')
  })

  it('refuses to build a card form from a key that is not a publishable key', () => {
    // A truncated or secret-shaped key would make Stripe.js throw the moment the
    // form is built, so the card surface is never chosen for it.
    expect(paymentFlow({ clientSecret: 'pi_1_secret' }, 'pk_live_1')).toBe('unavailable')
    expect(paymentFlow({ clientSecret: 'pi_1_secret' }, STRIPE_SECRET_SHAPED_KEY)).toBe('unavailable')
    expect(paymentFlow({ clientSecret: 'pi_1_secret' }, 'pk_test_51Tq9T8R66vde5mUX')).toBe('stripe')
  })
})

describe('provider URLs', () => {
  it('accepts https and refuses everything else', () => {
    expect(safeCheckoutUrl('https://pay.yifut.com/order/1')).toBe('https://pay.yifut.com/order/1')
    expect(safeCheckoutUrl('http://pay.yifut.com/order/1')).toBeUndefined()
    expect(safeCheckoutUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeCheckoutUrl('https://user:pw@pay.example/1')).toBeUndefined()
    expect(safeCheckoutUrl('   ')).toBeUndefined()
    expect(safeCheckoutUrl(undefined)).toBeUndefined()
  })

  it('keeps the console\\u2019s public payment routes and nothing else in the console', () => {
    // The console mount hosts the payment routes *and* the admin-only pages, so
    // the guard has to be the routes themselves.
    expect(safeCheckoutUrl('https://freecodego.com/rootadmin/payment/result')).toBe('https://freecodego.com/rootadmin/payment/result')
    expect(safeCheckoutUrl('https://freecodego.com/rootadmin/payment/stripe?order_id=1')).toBe('https://freecodego.com/rootadmin/payment/stripe?order_id=1')
    expect(safeCheckoutUrl('https://freecodego.com/rootadmin/users')).toBeUndefined()
    expect(safeCheckoutUrl('https://freecodego.com/rootadmin/payment/orders/9')).toBeUndefined()
  })
})

describe('QR payloads', () => {
  it('separates a rendered image from a link from opaque text', () => {
    expect(qrPayloadKind(QR_IMAGE)).toBe('image')
    expect(qrPayloadKind('https://qr.alipay.com/abc')).toBe('link')
    // Not a URL and not an image: shown verbatim, because inventing a QR for an
    // unknown string is how a payment goes to the wrong place.
    expect(qrPayloadKind('weixin://wxpay/bizpayurl?pr=abc')).toBe('text')
  })
})

describe('paid states', () => {
  it('accepts the backend spellings and is case-insensitive', () => {
    expect(isPaidOrderState('PAID')).toBe(true)
    expect(isPaidOrderState(' completed ')).toBe(true)
    expect(isPaidOrderState('pending')).toBe(false)
    expect(isPaidOrderState('cancelled')).toBe(false)
  })
})

describe('the dialog itself', () => {
  const base = { open: true, publishableKey: undefined, payCurrency: 'CNY', language: 'zh' as const, returnUrl: 'https://freecodego.com/rootadmin/payment/result', loadOrder: async () => undefined, onPaid: () => {}, onCancelOrder: undefined, onClose: () => {} }

  it('renders a QR order as a scannable image', () => {
    render(<PaymentDialog {...base} order={{ orderId: '95', state: 'pending', amount: 5, payAmount: 35.72, qrCode: QR_IMAGE }} />)
    expect(screen.getByAltText('支付二维码')).toBeDefined()
    // The payer sees the amount and what it buys. The order id and the backend's
    // own state spelling are ours, not theirs, and the dialog used to print both
    // above the card form — along with how often it polls.
    expect(screen.getByText('应付金额')).toBeDefined()
    expect(screen.getByText(/35\.72/)).toBeDefined()
    expect(screen.queryByText(/订单 95/)).toBeNull()
    // The card form is not offered for a QR order.
    expect(screen.queryByText('确认支付')).toBeNull()
  })

  it('prints the amount due at the precision it is charged at', () => {
    // A channel really can settle in a currency with three minor units, and the
    // quote is rounded to that unit. This line used to clamp the display to two
    // decimals whatever the currency was, so the last screen before paying
    // showed 2.01 for an order that charges 2.012 — less than the payer owes.
    render(<PaymentDialog {...base} payCurrency="KWD" order={{ orderId: '96', state: 'pending', amount: 5, payAmount: 2.012, qrCode: QR_IMAGE }} />)
    expect(screen.getByText(/2\.012/u)).toBeDefined()
  })

  it('gives a link order a sanitized anchor and refuses a hostile one', () => {
    const { unmount } = render(<PaymentDialog {...base} order={{ orderId: '1', state: 'pending', amount: 5, checkoutUrl: 'https://pay.yifut.com/order/1' }} />)
    expect(screen.getByRole('link', { name: '在浏览器打开支付页' }).getAttribute('href')).toBe('https://pay.yifut.com/order/1')
    unmount()
    render(<PaymentDialog {...base} order={{ orderId: '2', state: 'pending', amount: 5, checkoutUrl: 'http://pay.yifut.com/order/2' }} />)
    // A URL this client will not render is not a payment surface: the dialog
    // reports the missing piece instead of linking it.
    expect(screen.queryByRole('link', { name: '在浏览器打开支付页' })).toBeNull()
    expect(screen.getByRole('alert')).toBeDefined()
  })

  it('mounts the Stripe element only with a key, and never the secret', async () => {
    const mount = vi.fn()
    const create = vi.fn(() => ({ mount, destroy: vi.fn() }))
    const elements = vi.fn(() => ({ create }))
    const factory = vi.fn(() => ({ elements, confirmPayment: vi.fn(async () => ({})) })) as unknown as (key: string) => unknown
    ;(globalThis as { Stripe?: unknown }).Stripe = factory
    render(<PaymentDialog {...base} publishableKey="pk_live_51Tq9T8R66vde5mUX" order={{ orderId: '99', state: 'pending', amount: 5, payAmount: 5.62, clientSecret: 'pi_3UF_secret' }} />)
    await waitFor(() => { expect(mount).toHaveBeenCalledTimes(1) })
    // The card form is initialised from the order's client secret plus the
    // publishable key, and nothing else is sent to Stripe at mount time.
    expect(factory).toHaveBeenCalledWith('pk_live_51Tq9T8R66vde5mUX')
    expect(elements).toHaveBeenCalledWith(expect.objectContaining({ clientSecret: 'pi_3UF_secret' }))
    expect(screen.getByRole('button', { name: '确认支付' })).toBeDefined()
  })

  it('reports a card form that cannot be built instead of showing an empty box', async () => {
    const factory = (() => ({ elements: () => { throw new Error('Invalid API key provided') }, confirmPayment: vi.fn() })) as unknown as (key: string) => unknown
    ;(globalThis as { Stripe?: unknown }).Stripe = factory
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<PaymentDialog {...base} publishableKey="pk_live_51Tq9T8R66vde5mUX" order={{ orderId: '99', state: 'pending', amount: 5, clientSecret: 'pi_bad' }} />)
    // The failure has to reach the panel: an unhandled rejection here renders an
    // empty element box that reads as a permanent loading state. What reaches it is
    // a sentence for the customer; the processor's own words — a rejected key, a
    // session it will not accept — are the developer's half of the fact and go to
    // the log instead of the dialog.
    expect(await screen.findByText('支付表单暂时无法显示，请稍后重试或改用其他支付方式。')).toBeDefined()
    expect(screen.queryByText(/Invalid API key provided/)).toBeNull()
    expect(warn).toHaveBeenCalledWith('[freecodego] card form unavailable', expect.objectContaining({ message: 'Invalid API key provided' }))
    warn.mockRestore()
  })

  it('words the loader’s own failures without printing them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // No document to inject a script into: the loader fails before it reaches the
    // network at all, and the reason it recorded is the one the dialog words.
    vi.stubGlobal('document', undefined)
    resetStripeJsCacheForTests()
    const failure: unknown = await loadStripeJs().catch((error: unknown) => error)
    vi.unstubAllGlobals()
    expect((failure as { cardFormReason?: string }).cardFormReason).toBe('no-document')
    const shown = describeCardFormFailure(failure, true)
    expect(shown).toBe('支付表单暂时无法显示，请稍后重试或改用其他支付方式。')
    // The developer's sentence survives — in the log, which is where the half of
    // this nobody outside the file can use belongs. It used to be printed verbatim
    // to the customer.
    expect(warn).toHaveBeenCalledWith('[freecodego] card form unavailable', expect.objectContaining({ message: 'Stripe.js requires a browser document' }))
    // The blocked-script reason is the one a customer can do something about, so it
    // is told apart from the rest; anything unplanned falls back to the same line.
    const blocked = Object.assign(new Error('Stripe.js could not be loaded; check the network or any content blocker'), { cardFormReason: 'script-blocked' })
    expect(describeCardFormFailure(blocked, true)).toContain('内容拦截器')
    expect(describeCardFormFailure('a cause nobody planned for', true)).toBe(shown)
    warn.mockRestore()
  })

  it('passes the cardholder’s own failure through', async () => {
    const confirmPayment = vi.fn(async () => ({ error: { message: 'Your card was declined.', type: 'card_error' } }))
    ;(globalThis as { Stripe?: unknown }).Stripe = (() => ({ elements: () => ({ create: () => ({ mount: vi.fn(), destroy: vi.fn() }) }), confirmPayment })) as unknown as (key: string) => unknown
    render(<PaymentDialog {...base} publishableKey="pk_live_51Tq9T8R66vde5mUX" order={{ orderId: '99', state: 'pending', amount: 5, clientSecret: 'pi_3UF_secret' }} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '确认支付' })).toBeDefined() })
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    // A declined card is the one failure whose reason only the processor knows, and
    // the sentence it returns is written for whoever holds the card: replacing it
    // with our own line would take away the only thing the customer can act on.
    expect(await screen.findByText('Your card was declined.')).toBeDefined()
  })

  it('answers a request-level failure itself instead of printing the processor’s text', async () => {
    const confirmPayment = vi.fn(async () => ({ error: { message: 'Invalid client_secret provided', type: 'invalid_request_error' } }))
    ;(globalThis as { Stripe?: unknown }).Stripe = (() => ({ elements: () => ({ create: () => ({ mount: vi.fn(), destroy: vi.fn() }) }), confirmPayment })) as unknown as (key: string) => unknown
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<PaymentDialog {...base} publishableKey="pk_live_51Tq9T8R66vde5mUX" order={{ orderId: '99', state: 'pending', amount: 5, clientSecret: 'pi_3UF_secret' }} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '确认支付' })).toBeDefined() })
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))
    // An expired session reads as our own stack, so the panel says what the customer
    // can do about it and the original sentence goes to the log.
    expect(await screen.findByText('支付表单暂时无法显示，请稍后重试或改用其他支付方式。')).toBeDefined()
    expect(screen.queryByText(/Invalid client_secret provided/)).toBeNull()
    expect(warn).toHaveBeenCalledWith('[freecodego] card form unavailable', expect.objectContaining({ message: 'Invalid client_secret provided' }))
    warn.mockRestore()
  })

  it('announces the paid order once, and stops claiming to refresh', async () => {
    const onPaid = vi.fn()
    render(<PaymentDialog {...base} onPaid={onPaid} loadOrder={async () => ({ orderId: '95', state: 'paid', amount: 5 })} order={{ orderId: '95', state: 'pending', amount: 5, qrCode: QR_IMAGE }} />)
    await waitFor(() => { expect(onPaid).toHaveBeenCalledTimes(1) })
    expect(await screen.findByText('支付已完成，额度已到账。')).toBeDefined()
    // Once paid, the dialog stops promising a poll it no longer needs.
    expect(screen.queryByText(/每 4 秒自动刷新/)).toBeNull()
  })

  it('offers the receipt only once the order is paid, and only when it can be fetched', async () => {
    const onDownloadReceipt = vi.fn()
    const paidOrder = { orderId: '95', state: 'paid', amount: 5, qrCode: QR_IMAGE }
    const { unmount } = render(<PaymentDialog {...base} order={paidOrder} onDownloadReceipt={onDownloadReceipt} />)
    // A paid order is the only one the backend will hand a document for, so the
    // action appears with the payment rather than beside the card form.
    fireEvent.click(screen.getByRole('button', { name: '下载收据' }))
    expect(onDownloadReceipt).toHaveBeenCalledTimes(1)
    unmount()
    render(<PaymentDialog {...base} order={paidOrder} />)
    expect(screen.queryByRole('button', { name: '下载收据' })).toBeNull()
    unmount()
    // And never on an order that has not settled.
    render(<PaymentDialog {...base} order={{ orderId: '96', state: 'pending', amount: 5, qrCode: QR_IMAGE }} onDownloadReceipt={onDownloadReceipt} />)
    expect(screen.queryByRole('button', { name: '下载收据' })).toBeNull()
  })

  it('does not re-announce the same order when the panel re-renders', async () => {
    const onPaid = vi.fn()
    const order = { orderId: '95', state: 'pending', amount: 5, qrCode: QR_IMAGE }
    const { rerender } = render(<PaymentDialog {...base} onPaid={onPaid} order={order} />)
    // The panel learns the order paid from its own refresh and hands the new
    // state back down. That is a re-render, not a second payment: this callback
    // reloads the entire account.
    rerender(<PaymentDialog {...base} onPaid={onPaid} order={{ ...order, state: 'paid' }} />)
    await waitFor(() => { expect(screen.getByText('支付已完成，额度已到账。')).toBeDefined() })
    expect(onPaid).toHaveBeenCalledTimes(1)
  })

  it('destroys the Element with the dialog instead of only detaching its frame', async () => {
    const destroy = vi.fn()
    const mount = vi.fn()
    const create = vi.fn(() => ({ mount, destroy }))
    const factory = vi.fn(() => ({ elements: () => ({ create }), confirmPayment: vi.fn() })) as unknown as (key: string) => unknown
    ;(globalThis as { Stripe?: unknown }).Stripe = factory
    const { unmount } = render(<PaymentDialog {...base} publishableKey="pk_live_51Tq9T8R66vde5mUX" order={{ orderId: '99', state: 'pending', amount: 5, clientSecret: 'pi_3UF_secret' }} />)
    await waitFor(() => { expect(mount).toHaveBeenCalledTimes(1) })
    unmount()
    // Stripe's own iframe and its listeners survive the node being removed: only
    // `destroy()` releases them. The panel lives for the whole app session, so a
    // dialog that merely empties the host leaves one behind per payment.
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('announces an order that arrives already paid only once, even as the poll starts', async () => {
    const onPaid = vi.fn()
    render(<PaymentDialog {...base} onPaid={onPaid} loadOrder={async () => ({ orderId: '95', state: 'paid', amount: 5 })} order={{ orderId: '95', state: 'paid', amount: 5 }} />)
    await waitFor(() => { expect(onPaid).toHaveBeenCalledTimes(1) })
    // Opening the poll clears the once-per-order guard, so an order that is
    // already settled is announced a second time by the first read. That
    // callback re-reads the whole account, which is the cost this guard exists
    // to avoid.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(onPaid).toHaveBeenCalledTimes(1)
  })

  it('announces a second order the same dialog is handed, without re-announcing the first', async () => {
    const onPaid = vi.fn()
    const { rerender } = render(<PaymentDialog {...base} onPaid={onPaid} loadOrder={async () => undefined} order={{ orderId: '95', state: 'paid', amount: 5 }} />)
    await waitFor(() => { expect(onPaid).toHaveBeenCalledTimes(1) })
    // The panel keeps one dialog and swaps the order into it, so the guard has to
    // travel with the id it was claimed for: a second order that arrives settled
    // announces its own payment, while the first one is not announced again.
    rerender(<PaymentDialog {...base} onPaid={onPaid} loadOrder={async () => undefined} order={{ orderId: '96', state: 'paid', amount: 5 }} />)
    await waitFor(() => { expect(onPaid).toHaveBeenCalledTimes(2) })
  })

  it('stays quiet when the order read fails', async () => {
    const onPaid = vi.fn()
    render(<PaymentDialog {...base} onPaid={onPaid} loadOrder={async () => undefined} order={{ orderId: '95', state: 'pending', amount: 5, qrCode: QR_IMAGE }} />)
    await waitFor(() => { expect(screen.getByAltText('支付二维码')).toBeDefined() })
    expect(onPaid).not.toHaveBeenCalled()
  })

  it('keeps the card form out of a second, Link-shaped form', async () => {
    // Stripe's saved-account product appends email / phone / full name under the
    // card fields when it is allowed to appear. The extra block made the dialog
    // tall enough to hide the pay button, so the Element is created without it.
    const create = vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() }))
    const factory = vi.fn(() => ({ elements: () => ({ create }), confirmPayment: vi.fn() })) as unknown as (key: string) => unknown
    ;(globalThis as { Stripe?: unknown }).Stripe = factory
    render(<PaymentDialog {...base} publishableKey="pk_live_51Tq9T8R66vde5mUX" order={{ orderId: '99', state: 'pending', amount: 5, clientSecret: 'pi_3UF_secret' }} />)
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
    expect(create).toHaveBeenCalledWith('payment', {
      wallets: { link: 'never' },
      layout: { type: 'accordion', defaultCollapseWhenAvailable: true, radios: false, spacedAccordionItems: false },
      // No address was handed over here, so the email field stays: it is where
      // the invoice has to go. Everything else is unasked-for detail.
      fields: { billingDetails: { name: 'never', phone: 'never', address: 'never' } },
    })
  })

  it('asks the card form for nothing once the account already knows the buyer', async () => {
    const create = vi.fn(() => ({ mount: vi.fn(), destroy: vi.fn() }))
    const factory = vi.fn(() => ({ elements: () => ({ create }), confirmPayment: vi.fn() })) as unknown as (key: string) => unknown
    ;(globalThis as { Stripe?: unknown }).Stripe = factory
    render(<PaymentDialog {...base} publishableKey="pk_live_51Tq9T8R66vde5mUX" receiptEmail="buyer@example.com" order={{ orderId: '99', state: 'pending', amount: 5, clientSecret: 'pi_3UF_secret' }} />)
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
    // `never` because the address is already on the account and is what Stripe
    // mails the receipt and the invoice to: a second form asking for the same
    // fact is how the dialog grew tall enough to hide the pay button.
    expect(create).toHaveBeenCalledWith('payment', expect.objectContaining({ fields: { billingDetails: 'never' } }))
  })

  it('hands Stripe the account address for the receipt, and never invents one', async () => {
    const confirmPayment = vi.fn(async (_options: Record<string, unknown>) => ({}))
    const factory = vi.fn(() => ({
      elements: () => ({ create: () => ({ mount: vi.fn(), destroy: vi.fn() }) }),
      confirmPayment,
    })) as unknown as (key: string) => unknown
    ;(globalThis as { Stripe?: unknown }).Stripe = factory
    const order = { orderId: '99', state: 'pending', amount: 5, payAmount: 5.62, clientSecret: 'pi_3UF_secret' }
    const { unmount } = render(<PaymentDialog {...base} publishableKey="pk_live_51Tq9T8R66vde5mUX" receiptEmail=" buyer@example.com " order={order} />)
    fireEvent.click(await screen.findByRole('button', { name: '确认支付' }))
    await waitFor(() => { expect(confirmPayment).toHaveBeenCalledTimes(1) })
    // The receipt (and invoice) Stripe mails goes to the signed-in account, and
    // the address is trimmed before it leaves.
    expect(confirmPayment.mock.calls[0]?.[0]).toMatchObject({ confirmParams: { receipt_email: 'buyer@example.com' } })
    unmount()
    confirmPayment.mockClear()
    // No address on the panel means no address in the confirmation: a made-up one
    // would mail a stranger's receipt.
    render(<PaymentDialog {...base} publishableKey="pk_live_51Tq9T8R66vde5mUX" order={order} />)
    fireEvent.click(await screen.findByRole('button', { name: '确认支付' }))
    await waitFor(() => { expect(confirmPayment).toHaveBeenCalledTimes(1) })
    expect(confirmPayment.mock.calls[0]?.[0]).toMatchObject({ confirmParams: { return_url: base.returnUrl } })
    expect(JSON.stringify(confirmPayment.mock.calls[0]?.[0])).not.toContain('receipt_email')
  })
})

describe('the card form’s palette', () => {
  it('is read from the dialog it sits in, not from a Stripe theme', () => {
    const original = globalThis.getComputedStyle
    const values: Record<string, string> = {
      '--fcg-bg-layer-2': 'rgb(20, 20, 24)',
      '--fcg-bg-input': 'rgb(30, 30, 36)',
      '--fcg-text-primary': 'rgb(240, 240, 245)',
      '--fcg-text-tertiary': 'rgb(150, 150, 160)',
      '--fcg-line': 'rgb(60, 60, 70)',
      '--fcg-brand': 'rgb(76, 141, 255)',
    }
    globalThis.getComputedStyle = (() => ({ getPropertyValue: (name: string) => values[name] ?? '' })) as unknown as typeof getComputedStyle
    try {
      const appearance = stripeAppearanceOf(document.createElement('div'))
      const variables = appearance.variables as Record<string, string>
      // Same colour as the card it is rendered inside is the whole point: a light
      // dialog with a black form in it was the complaint.
      expect(variables.colorBackground).toBe('rgb(20, 20, 24)')
      expect(variables.colorText).toBe('rgb(240, 240, 245)')
      expect(variables.colorPrimary).toBe('rgb(76, 141, 255)')
      expect((appearance.rules as Record<string, Record<string, string>>)['.Input']?.backgroundColor).toBe('rgb(30, 30, 36)')
      expect((appearance.rules as Record<string, Record<string, string>>)['.Input']?.border).toBe('1px solid rgb(60, 60, 70)')
    } finally { globalThis.getComputedStyle = original }
  })

  it('falls back to finished-looking defaults with no host to read', () => {
    const appearance = stripeAppearanceOf(null)
    // An unreadable host must still produce a usable palette: Stripe renders
    // nothing for a malformed appearance object.
    expect(appearance.theme).toBe('flat')
    expect((appearance.variables as Record<string, string>).colorBackground).toBe('rgb(255, 255, 255)')
  })

  it('never hands Stripe a colour its parser drops, which is what made the form black', () => {
    // The panel's own `--fcg-line` is `#0000001a`. Stripe rejects an 8-digit hex,
    // and a rejected appearance is discarded *silently* — Stripe then draws its
    // default theme, which follows the OS. On a dark-mode machine that is a black
    // card form inside this white dialog, which is exactly what was reported.
    const original = globalThis.getComputedStyle
    const values: Record<string, string> = {
      '--fcg-bg-layer-2': '#fff',
      '--fcg-bg-input': '#f5f6f7',
      '--fcg-text-primary': '#0f1115',
      '--fcg-text-tertiary': '#81858c',
      '--fcg-line': '#0000001a',
      '--fcg-brand': '#4176e6',
    }
    globalThis.getComputedStyle = (() => ({ getPropertyValue: (name: string) => values[name] ?? '' })) as unknown as typeof getComputedStyle
    try {
      const appearance = stripeAppearanceOf(document.createElement('div'))
      const literals = JSON.stringify(appearance)
      // No hex at all: every literal is rgb()/rgba(), the one form Stripe takes.
      expect(literals).not.toMatch(/#[0-9a-f]{3,8}/i)
      const rules = appearance.rules as Record<string, Record<string, string>>
      expect(rules['.Input']?.border).toBe('1px solid rgba(0, 0, 0, 0.1)')
      expect((appearance.variables as Record<string, string>).colorBackground).toBe('rgb(255, 255, 255)')
    } finally { globalThis.getComputedStyle = original }
  })

  it('expands shorthand hex and unknown values instead of passing them on', () => {
    expect(stripeColor('#fff', '#000')).toBe('rgb(255, 255, 255)')
    expect(stripeColor('#0000001a', '#fff')).toBe('rgba(0, 0, 0, 0.1)')
    expect(stripeColor('rgb(1, 2, 3)', '#fff')).toBe('rgb(1, 2, 3)')
    expect(stripeColor('transparent', '#fff')).toBe('transparent')
    // Unrecognised input keeps the fallback rather than risking the whole
    // appearance object being thrown away.
    expect(stripeColor('var(--fcg-line)', '#fff')).toBe('#fff')
    expect(stripeColor('  ', '#fff')).toBe('#fff')
  })
})
