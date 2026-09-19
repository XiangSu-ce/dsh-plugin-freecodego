/**
 * The filename a receipt download is saved under.
 *
 * Why this is worth its own case
 * ------------------------------
 * The name comes from the backend's `Content-Disposition` header and goes
 * straight into the browser's save dialog, so it is the one string on this path
 * that travels from a response header to the user's disk. The backend names the
 * file after the order (`freecodego-receipt-<no>.html`); this pins that the
 * header is honoured, and that anything which could escape a download directory
 * is stripped rather than trusted.
 *
 * @module tests/receipt-document
 */

import { describe, expect, it } from 'vitest'
import { receiptFileName } from '../src/index.ts'

describe('receipt filename', () => {
  it('uses the backend’s own filename', () => {
    expect(receiptFileName('attachment; filename="freecodego-receipt-FCG-R-1.html"', 'fallback.html')).toBe('freecodego-receipt-FCG-R-1.html')
    // Unquoted and RFC 5987 spellings are both in the wild.
    expect(receiptFileName('attachment; filename=freecodego-receipt-2.html', 'fallback.html')).toBe('freecodego-receipt-2.html')
    expect(receiptFileName("attachment; filename*=UTF-8''freecodego-receipt-3.html", 'fallback.html')).toBe('freecodego-receipt-3.html')
  })

  it('falls back rather than saving a file with no name', () => {
    expect(receiptFileName(null, 'freecodego-receipt-9.html')).toBe('freecodego-receipt-9.html')
    expect(receiptFileName(undefined, 'freecodego-receipt-9.html')).toBe('freecodego-receipt-9.html')
    expect(receiptFileName('attachment', 'freecodego-receipt-9.html')).toBe('freecodego-receipt-9.html')
    expect(receiptFileName('attachment; filename=""', 'freecodego-receipt-9.html')).toBe('freecodego-receipt-9.html')
  })

  it('refuses to carry a path out of the header', () => {
    // A separator or a parent segment in the name is how a "receipt" ends up
    // somewhere other than the downloads folder.
    expect(receiptFileName('attachment; filename="../../etc/passwd"', 'safe.html')).toBe('etcpasswd')
    expect(receiptFileName('attachment; filename="C:\\Users\\x\\receipt.html"', 'safe.html')).toBe('CUsersxreceipt.html')
    // A real NUL byte, not the six characters that spell one.
    expect(receiptFileName(`attachment; filename="re${String.fromCharCode(0)}ceipt.html"`, 'safe.html')).toBe('receipt.html')
    // A name that was *only* traversal characters collapses to the fallback.
    expect(receiptFileName('attachment; filename="../"', 'safe.html')).toBe('safe.html')
  })
})
