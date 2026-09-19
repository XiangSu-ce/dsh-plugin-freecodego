/**
 * How this plugin writes a money amount, and how it rounds one up.
 *
 * Two surfaces quote the same number: the Settings panel's checkout button (the
 * fee breakdown plus the total it adds up to) and the payment dialog's "amount
 * due", which is the last thing a payer reads before paying. Each had its own
 * copy of the formatter, and the copies had drifted — the panel rounded to the
 * currency's own minor unit and then displayed two digits, while the dialog
 * clamped the display to two digits outright — so a currency with three of them
 * (KWD, BHD, OMR) showed an amount that was not the amount charged. The rule is
 * the same on both surfaces and belongs in one place: an amount is displayed at
 * the precision it was charged at.
 *
 * The two failure modes this module has to answer are opposite, which is why the
 * resolution of a currency code is exposed once and its *callers* decide:
 *
 * - A code this runtime cannot name is a **display** problem. `Intl` accepts
 *   only codes shaped like a currency — three ASCII letters — and throws on
 *   everything else a price feed really produces (a padded `" CNY "`, a symbol
 *   `"￥"`, a four-letter `"USDT"`, an empty string). Since all of this runs
 *   inside render, the throw did not degrade one cell; it took the whole panel
 *   down. {@link formatMoney} answers with the number plus the backend's own
 *   label instead.
 * - The same unnameable code on the **quoting** path is not recoverable, because
 *   {@link roundUpCurrency} would have to guess the currency's smallest unit.
 *   That guess is the one error here that costs real money, so it throws.
 *
 * @module dsh-freecodego-harness-ui/client/money-format
 */

/**
 * A code's minor-unit precision, or `undefined` when this runtime cannot name it.
 *
 * `Intl` answers both a malformed code and an unknown one by throwing, so the
 * question "how many digits does this currency have" is asked in one place that
 * can answer `undefined` instead.
 */
function fractionDigitsOf(currency: string): number | undefined {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
  } catch { return undefined }
}

/**
 * The precision the *payer* is charged at, which has no fallback.
 *
 * `roundUpCurrency` rounds into this, so falling back to two digits for a code
 * this runtime cannot name would quote an amount in a currency whose smallest
 * unit is unknown. Padding is trimmed first, because the channel table passes
 * the backend's string through verbatim.
 */
function currencyFractionDigits(currency: string | undefined): number {
  if (currency === undefined || currency.trim() === '') throw new Error('FreeCodeGo payment channel currency is required')
  const code = currency.trim()
  const digits = fractionDigitsOf(code)
  if (digits === undefined) throw new Error(`FreeCodeGo currency ${code} is not a currency code this runtime can name`)
  return digits
}

/**
 * A money amount in `currency`, and never an exception.
 *
 * See the module note above for what throws and why the display path must not:
 * the fallback prints the amount followed by the backend's own code, the one
 * label this client can show without inventing a symbol nobody quoted.
 */
export function formatAmountInCurrency(value: number, currency: string, digits: number): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: digits }).format(value)
  } catch {
    // `minimumFractionDigits` may not exceed the maximum, so the fallback pads
    // to the same two decimals only when the ceiling leaves room for them.
    const padding = { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits }
    const amount = new Intl.NumberFormat(undefined, padding).format(value)
    return currency === '' ? amount : `${amount} ${currency}`
  }
}

/**
 * Render one amount in the currency it is denominated in.
 *
 * The fraction digits come from the currency rather than from a fixed two,
 * because the amount shown here was rounded to that currency's minor unit by
 * {@link roundUpCurrency}, which reads the same table: the two used to disagree,
 * so the dinar's third digit — the part the order actually charges — was dropped
 * from the screen while a two-digit clamp stayed harmless for USD and CNY. (A
 * per-token *price* is deliberately not this function: it needs more digits than
 * the currency's unit, and it is never charged as-is.)
 *
 * The em dash for an absent or non-finite amount is deliberate: an invented zero
 * beside a real payment reads as a completed one.
 *
 * @param value - Amount in `currency`, or absent when the source reported none.
 * @param currency - ISO code the amount is denominated in; `USD` when absent.
 * @returns The localized amount, or `—` when there is no number to show.
 */
export function formatMoney(value: number | undefined, currency: string | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  const code = (currency ?? 'USD').trim()
  // An unknown code is a label problem, not an unreadable price: the amount is
  // printed at the precision the charge used when the runtime can name the
  // currency, and at two digits beside the backend's own label when it cannot.
  return formatAmountInCurrency(value, code, fractionDigitsOf(code) ?? 2)
}

/**
 * Relative slack the ceiling below absorbs before it moves an amount.
 *
 * A quoted total is a sum of parts that are each already rounded to the
 * currency's smallest unit (the base, the percentage fee, the fixed fee), so the
 * sum lands within a few floating-point steps of its exact figure — sometimes
 * just above it. This absorbs that error and stays far below the smallest
 * fraction a payer could name.
 */
const ROUND_UP_SLACK = 1e-9
/** Ceiling for the slack above, so it cannot swallow a real fraction at any magnitude. */
const ROUND_UP_SLACK_CAP = 1e-3

/**
 * Round a payment amount up to the currency's smallest unit.
 *
 * Rounding up is deliberate — a quote rounded down is money the payer never
 * agreed to. But only a *fraction* of a minor unit may move. The expression this
 * replaces subtracted `Number.EPSILON` from the scaled product; that constant is
 * the gap between 1 and the next double, so at the magnitude of any real amount
 * it changed nothing, and a sum of already-rounded parts that landed one step
 * high was raised by a whole minor unit: `2.20` was quoted as `2.21`, the stated
 * base plus fee no longer added up to the total, and about 4.6% of two-decimal
 * amounts were affected. The slack has to scale with the value to absorb exactly
 * that error and nothing larger.
 *
 * @param value - The unrounded amount, in the currency's own units.
 * @param currency - ISO code whose minor unit the amount is rounded to.
 * @returns The smallest amount at that precision which is not below `value`.
 */
export function roundUpCurrency(value: number, currency: string | undefined): number {
  const digits = currencyFractionDigits(currency)
  const unit = 10 ** digits
  const scaled = value * unit
  const slack = Math.min(Math.abs(scaled) * ROUND_UP_SLACK, ROUND_UP_SLACK_CAP)
  return Math.ceil(scaled - slack) / unit
}
