/**
 * The token-usage settings section must not type-erase its registration.
 *
 * This section declared its props as an object literal at the parameter, which
 * names only the inject face. The slot also passes its own runtime props, so the
 * literal did not match, and the registration silenced the mismatch with
 * `as unknown as never` — erasing the check for *every* prop, not only the
 * missing ones.
 *
 * Removing the cast immediately surfaced a real defect it had been hiding: under
 * `exactOptionalPropertyTypes`, a `?` seat is not the same type as one that
 * admits `undefined`, and the composed props hand `sessionId` over as
 * `string | undefined`. The component had been declaring `string`.
 *
 * Two halves, because they fail in different places:
 * - the **type** half is a compile-time assertion. It is enforced by
 *   `tsc -p tsconfig.test.json` (part of the gate), not by vitest, which does not
 *   type check. Reverting the `| undefined` seats makes that compile fail.
 * - the **cast** half is a source assertion, because re-adding a cast is exactly
 *   the change that makes the compiler stop complaining.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { TokenUsageDashboardInjected } from '../src/client/token-usage-dashboard.tsx'

describe('the token-usage section declares real props', () => {
  it('admits the undefined the composed props actually carry', () => {
    // A pure type assertion: nothing here runs. The composed props hand the
    // optional seats over as `T | undefined`, and `exactOptionalPropertyTypes`
    // makes that an error unless the declared face says so. The cast used to be
    // what kept this from ever being noticed.
    const seats: Pick<TokenUsageDashboardInjected, 'tokenUsageCurrentSession' | 'accountStatus' | 'sessionId'> = {
      tokenUsageCurrentSession: undefined,
      accountStatus: undefined,
      sessionId: undefined,
    }
    expect(seats).toEqual({ tokenUsageCurrentSession: undefined, accountStatus: undefined, sessionId: undefined })
  })

  it('registers the component directly rather than erasing its type', () => {
    const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
    const registration = source.split('\n').find(line => line.includes('}, TokenUsageDashboard'))
    expect(registration, 'the token-usage section registration is gone').toBeDefined()
    expect(registration).not.toContain('as unknown as')
  })
})
