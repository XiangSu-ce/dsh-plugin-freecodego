// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_MODEL_PICKER_VISIBILITY,
  bareModelId,
  clearModelPickerVisibility,
  isModelVisible,
  isProviderVisible,
  modelVisibilityKey,
  normalizeModelPickerVisibility,
  readModelPickerVisibility,
  setModelVisible,
  setModelsVisible,
  setProviderVisible,
  subscribeModelPickerVisibility,
  writeModelPickerVisibility,
} from '../src/client/model-picker-visibility.ts'

beforeEach(() => { globalThis.localStorage.clear() })
afterEach(() => { globalThis.localStorage.clear() })

describe('model picker visibility store', () => {
  it('shows everything until something is switched off', () => {
    // Negative storage is the whole design: the picker's composed contents are
    // the default, so a user who never opens the controls sees no change, and a
    // model a provider adds later arrives visible instead of missing because a
    // snapshot predates it.
    const empty = readModelPickerVisibility()
    expect(empty).toEqual(EMPTY_MODEL_PICKER_VISIBILITY)
    expect(isProviderVisible(empty, 'workbuddy')).toBe(true)
    expect(isModelVisible(empty, 'workbuddy', 'wb-free')).toBe(true)
    // An unresolvable group is never hidden: the decorator must not silence a
    // section it cannot name.
    expect(isProviderVisible(empty, undefined)).toBe(true)
  })

  it('hides a switched-off provider and every model under it, keeping the row choices', () => {
    const off = setProviderVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'WorkBuddy', false)
    // Case-folded: the settings card and the picker directory spell the
    // provider id the same way, but neither is trusted to.
    expect(isProviderVisible(off, 'workbuddy')).toBe(false)
    expect(isModelVisible(off, 'workbuddy', 'wb-free')).toBe(false)
    // The per-model entry is untouched, so switching the provider back on
    // restores exactly the rows the user had picked.
    expect(off.models).toEqual({})
    expect(isModelVisible(setProviderVisible(off, 'workbuddy', true), 'workbuddy', 'wb-free')).toBe(true)
  })

  it('folds every gateway group pin into one decision', () => {
    // One decision covers a model's whole group family: unchecking the row the
    // user saw must not leave the same model visible under another group.
    expect(bareModelId('claude-fable-5@group:4')).toBe('claude-fable-5')
    expect(bareModelId('kimi-k3')).toBe('kimi-k3')
    expect(modelVisibilityKey('FreeCodeGo', ' claude-fable-5@group:4 ')).toBe('freecodego\u0000claude-fable-5')
    const off = setModelVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'freecodego', 'claude-fable-5@group:4', false)
    expect(isModelVisible(off, 'freecodego', 'claude-fable-5@group:7')).toBe(false)
    expect(isModelVisible(off, 'freecodego', 'kimi-k3@group:4')).toBe(true)
    // A different provider's identically named model is a different row.
    expect(isModelVisible(off, 'logfare', 'claude-fable-5')).toBe(true)
  })

  it('starts a curated provider on only its declared default routes', () => {
    // VyceAI's whole directory is metered, so its unnamed rows start hidden:
    // saving a key must not fill the picker with a dozen ways to spend money.
    const empty = readModelPickerVisibility()
    expect(isModelVisible(empty, 'vyce', 'vyce/deepseek-v4.1')).toBe(true)
    // Both spellings of the id resolve to the same default.
    expect(isModelVisible(empty, 'vyce', 'deepseek-v4.1')).toBe(true)
    expect(isModelVisible(empty, 'vyce', 'vyce/qwen3.8-flash')).toBe(true)
    expect(isModelVisible(empty, 'vyce', 'vyce/glm-5.3')).toBe(false)
    // A provider with no declared default is untouched.
    expect(isModelVisible(empty, 'logfare', 'glm-5.3')).toBe(true)
  })

  it('stores the exception both ways for a curated provider', () => {
    // Switching on a hidden-by-default row stores `true`; switching off a
    // default row stores `false`; agreeing with the default stores nothing, so
    // Reset stays a matter of dropping keys.
    const on = setModelVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'vyce', 'vyce/glm-5.3', true)
    expect(on.models).toEqual({ 'vyce\u0000vyce/glm-5.3': true })
    expect(isModelVisible(on, 'vyce', 'vyce/glm-5.3')).toBe(true)
    const off = setModelVisible(on, 'vyce', 'vyce/deepseek-v4.1', false)
    expect(off.models).toEqual({ 'vyce\u0000vyce/glm-5.3': true, 'vyce\u0000vyce/deepseek-v4.1': false })
    expect(isModelVisible(off, 'vyce', 'vyce/deepseek-v4.1')).toBe(false)
    // Back to the default: the key is dropped rather than flipped.
    expect(setModelVisible(off, 'vyce', 'vyce/deepseek-v4.1', true).models).toEqual({ 'vyce\u0000vyce/glm-5.3': true })
  })

  it('applies All and None as exceptions against each row\u2019s default', () => {
    const rows = ['vyce/deepseek-v4.1', 'vyce/qwen3.8-flash', 'vyce/glm-5.3'].map(id => ({ id }))
    // All: only the row that starts off has to be recorded.
    const all = setModelsVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'vyce', rows, true)
    expect(all.models).toEqual({ 'vyce\u0000vyce/glm-5.3': true })
    // None: only the two that start on have to be recorded.
    const none = setModelsVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'vyce', rows, false)
    expect(none.models).toEqual({ 'vyce\u0000vyce/deepseek-v4.1': false, 'vyce\u0000vyce/qwen3.8-flash': false })
    expect(isModelVisible(none, 'vyce', 'vyce/glm-5.3')).toBe(false)
    expect(isModelVisible(none, 'vyce', 'vyce/deepseek-v4.1')).toBe(false)
  })

  it('applies one decision to a whole roster in a single write', () => {
    const off = setModelsVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'cline', ['a', 'b'].map(id => ({ id })), false)
    expect(isModelVisible(off, 'cline', 'a')).toBe(false)
    expect(isModelVisible(off, 'cline', 'b')).toBe(false)
    expect(Object.keys(off.models)).toHaveLength(2)
    const on = setModelsVisible(off, 'cline', [{ id: 'a' }], true)
    expect(isModelVisible(on, 'cline', 'a')).toBe(true)
    expect(isModelVisible(on, 'cline', 'b')).toBe(false)
  })

  it('starts a metered provider\u2019s priced rows hidden while the free ones stay offered', () => {
    // The row states its own price and the price — not the provider — is what
    // decides, because these rosters hold both tiers: a free budget beside the
    // routes that cost money.
    const empty = readModelPickerVisibility()
    expect(isModelVisible(empty, 'cline', 'cline/free-route', 'free')).toBe(true)
    expect(isModelVisible(empty, 'cline', 'cline/paid-route', 'paid')).toBe(false)
    // A price the directory never stated is not read as paid: the user already
    // answered "may this be in my list" by configuring that provider.
    expect(isModelVisible(empty, 'cline', 'cline/unpriced', 'unknown')).toBe(true)
    // The gateway is deliberately out of scope — its directory is the account's
    // own plan, and this page is not a second billing decision for it.
    expect(isModelVisible(empty, 'freecodego', 'gpt-5.6', 'paid')).toBe(true)
  })

  it('keeps a priced row the user switched on, which is the point of listing it', () => {
    const on = setModelVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'qoder', 'qmodel_38max', true, 'paid')
    expect(on.models).toEqual({ 'qoder\u0000qmodel_38max': true })
    expect(isModelVisible(on, 'qoder', 'qmodel_38max', 'paid')).toBe(true)
    // Switching it back off agrees with the price again, so nothing is stored.
    expect(setModelVisible(on, 'qoder', 'qmodel_38max', false, 'paid').models).toEqual({})
    // An unpicked free row that the user unchecks is still stored: that disagrees.
    expect(setModelVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'cline', 'free-route', false, 'free').models)
      .toEqual({ 'cline\u0000free-route': false })
  })

  it('prices each row separately when All or None is applied', () => {
    // "All" must not switch a metered row on: the user asked for everything they
    // were being offered, and a priced route was not part of that offer.
    const rows = [{ id: 'free-a', price: 'free' as const }, { id: 'paid-b', price: 'paid' as const }]
    expect(setModelsVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'cline', rows, true).models)
      .toEqual({ 'cline\u0000paid-b': true })
    expect(setModelsVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'cline', rows, false).models)
      .toEqual({ 'cline\u0000free-a': false })
  })

  it('keeps only booleans, so one corrupt entry cannot hide a section nobody hid', () => {
    // The document is hand-editable and versioned; anything that is not a
    // boolean is dropped rather than coerced. `true` is kept: for a curated
    // provider it is a row the user switched on that starts off.
    expect(normalizeModelPickerVisibility({ providers: { a: true, b: false, c: 'no' }, models: { 'x\u0000y': 0 } }))
      .toEqual({ providers: { a: true, b: false }, models: {} })
    expect(normalizeModelPickerVisibility('nonsense')).toEqual(EMPTY_MODEL_PICKER_VISIBILITY)
    expect(normalizeModelPickerVisibility(null)).toEqual(EMPTY_MODEL_PICKER_VISIBILITY)
    globalThis.localStorage.setItem('freecodego.modelPicker.visibility.v1', '{not json')
    expect(readModelPickerVisibility()).toEqual(EMPTY_MODEL_PICKER_VISIBILITY)
  })

  it('round-trips through storage and reports what it stored', () => {
    writeModelPickerVisibility(setModelVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'logfare', 'logfare/glm-5.3', false))
    expect(readModelPickerVisibility()).toEqual({ providers: {}, models: { 'logfare\u0000logfare/glm-5.3': false } })
  })

  it('round-trips an exception that switches a curated row on', () => {
    // The one stored shape that is not a refusal: a row the user added to a
    // provider whose rows otherwise start hidden.
    writeModelPickerVisibility(setModelVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'vyce', 'vyce/glm-5.3', true))
    expect(readModelPickerVisibility()).toEqual({ providers: {}, models: { 'vyce\u0000vyce/glm-5.3': true } })
  })

  it('announces every change and stops when the subscription is disposed', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeModelPickerVisibility(listener)
    writeModelPickerVisibility(setProviderVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'cline', false))
    expect(listener).toHaveBeenCalledTimes(1)
    // Reset is a change like any other: the panel and an open menu both have to
    // hear that the picker is back to its composed contents.
    expect(clearModelPickerVisibility()).toEqual(EMPTY_MODEL_PICKER_VISIBILITY)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(readModelPickerVisibility()).toEqual(EMPTY_MODEL_PICKER_VISIBILITY)
    unsubscribe()
    writeModelPickerVisibility(setProviderVisible(EMPTY_MODEL_PICKER_VISIBILITY, 'cline', false))
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
