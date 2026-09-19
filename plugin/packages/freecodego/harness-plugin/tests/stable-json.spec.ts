import { describe, expect, it } from 'vitest'
import { stableJson, stableJsonStrict } from '../src/stable-json.ts'

describe('stableJson encoding', () => {
  it('encodes primitives with JSON semantics', () => {
    expect(stableJson(null)).toBe('null')
    expect(stableJson(true)).toBe('true')
    expect(stableJson(42)).toBe('42')
    expect(stableJson('x')).toBe('"x"')
  })

  it('encodes a non-representable primitive when JSON.stringify yields undefined', () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string.
    expect(stableJson(undefined)).toBe('null')
    expect(stableJson(() => 1)).toBe('null')
    expect(stableJson(Symbol('s'))).toBe('null')
  })

  it('preserves array order and encodes an explicit undefined slot as null', () => {
    expect(stableJson([1, 'a', true])).toBe('[1,"a",true]')
    expect(stableJson([1, undefined, 3])).toBe('[1,null,3]')
  })

  it('encodes a hole as null, the way JSON.stringify does', () => {
    // The case the name above used to promise while only passing an explicit
    // `undefined`: `map` skips holes, so a real hole encoded as `[,]` — text that
    // is not JSON — where `JSON.stringify` produces `[null,null]`. Built by
    // length rather than by a sparse literal so the input is unambiguous.
    const sparse: unknown[] = []
    sparse.length = 2
    expect(stableJson(sparse)).toBe('[null,null]')
    expect(stableJson(sparse)).toBe(JSON.stringify(sparse))
    expect(stableJsonStrict(sparse)).toBe(JSON.stringify(sparse))
  })

  it('keeps the position of a hole between real values', () => {
    // Writing index 2 on an empty array leaves index 1 with no value of its own.
    const sparse: unknown[] = []
    sparse[0] = 1
    sparse[2] = 3
    expect(sparse.length).toBe(3)
    expect(stableJson(sparse)).toBe(JSON.stringify(sparse))
    expect(stableJson(sparse)).toBe('[1,null,3]')
  })

  it('encodes an empty object and an empty array', () => {
    expect(stableJson({})).toBe('{}')
    expect(stableJson([])).toBe('[]')
  })

  it('sorts object keys by code point, not insertion order', () => {
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(stableJson({ a: 2, b: 1 })).toBe(stableJson({ b: 1, a: 2 }))
  })

  it('orders keys independently of the host locale', () => {
    // Uppercase sorts before lowercase by code point. `localeCompare` in most
    // collations orders these the other way, which is what made the previous
    // per-module encoders disagree.
    expect(stableJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}')
  })

  it('orders multibyte keys by code point', () => {
    expect(stableJson({ z: 1, '\u00e9': 2, a: 3 })).toBe('{"a":3,"z":1,"\u00e9":2}')
  })

  it('drops undefined-valued properties, matching JSON.stringify', () => {
    expect(stableJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(stableJson({ a: 1 })).toBe(stableJson({ a: 1, b: undefined }))
  })

  it('keeps a null-valued property', () => {
    expect(stableJson({ a: null })).toBe('{"a":null}')
  })

  it('encodes nested objects recursively', () => {
    expect(stableJson({ z: { b: 1, a: 2 }, a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}],"z":{"a":2,"b":1}}')
  })

  it('escapes keys and string values that need escaping', () => {
    expect(stableJson({ 'a"b': 'x\n' })).toBe('{"a\\"b":"x\\n"}')
  })

  it('encodes a repeated sibling sub-object normally (path set, not seen set)', () => {
    const shared = { k: 1 }
    expect(stableJson({ left: shared, right: shared })).toBe('{"left":{"k":1},"right":{"k":1}}')
  })

  it('does not mutate the value it is given', () => {
    const value = { b: 1, a: 2, drop: undefined }
    stableJson(value)
    expect(Object.keys(value)).toEqual(['b', 'a', 'drop'])
  })
})

describe('stableJsonStrict cycle handling', () => {
  it('throws a labelled error naming this module', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => stableJsonStrict(cyclic)).toThrow(/stable-json: .*reference cycle/u)
  })

  it('detects a cycle that is reachable through an array', () => {
    const list: unknown[] = []
    list.push(list)
    expect(() => stableJsonStrict(list)).toThrow(/reference cycle/u)
  })

  it('detects a cycle nested inside otherwise ordinary data', () => {
    const root: Record<string, unknown> = { outer: { list: [{}] } }
    const holder = (root.outer as { list: unknown[] }).list[0] as Record<string, unknown>
    holder.back = root
    expect(() => stableJsonStrict(root)).toThrow(/reference cycle/u)
  })

  it('accepts a repeated sibling that is not reachable from itself', () => {
    const shared = { k: 1 }
    expect(stableJsonStrict({ left: shared, right: shared })).toBe('{"left":{"k":1},"right":{"k":1}}')
  })
})

describe('stableJson cycle tolerance', () => {
  it('substitutes null for a self-referencing object instead of throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    expect(stableJson(cyclic)).toBe('{"a":1,"self":null}')
  })

  it('substitutes null for a self-referencing array instead of throwing', () => {
    const list: unknown[] = [1]
    list.push(list)
    expect(stableJson(list)).toBe('[1,null]')
  })

  it('keeps encoding values after a cycle was substituted', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(stableJson({ first: cyclic, tail: 'kept' })).toBe('{"first":{"self":null},"tail":"kept"}')
  })
})

describe('cross-encoder agreement', () => {
  it('produces identical bytes for every acyclic input both encoders accept', () => {
    const samples: unknown[] = [
      null,
      42,
      'text',
      [1, [2, [3]]],
      { b: 1, a: { d: 2, c: 3 } },
      { dropped: undefined, kept: null },
      { 'k"1': { 'z!': [true, false] } },
    ]
    for (const sample of samples) {
      expect(stableJson(sample)).toBe(stableJsonStrict(sample))
    }
  })
})
