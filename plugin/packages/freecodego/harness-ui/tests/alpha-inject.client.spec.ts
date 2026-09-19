// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { inject } from '../src/client/index.ts'

describe('FreeCodeGo alpha.1 client injection', () => {
  it('declares sessions before reading the current session from the root context', () => {
    expect(inject).toContain('sessions')
  })
})
