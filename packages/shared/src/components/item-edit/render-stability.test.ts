import { describe, expect, it } from 'vitest'
import {
  groupSectionPropsEqual,
  jsonEqual,
  keepIfEqual,
  shallowRecordEqual
} from './render-stability'

describe('jsonEqual / shallowRecordEqual', () => {
  it('compares plain data by content', () => {
    expect(jsonEqual({ a: { _eq: 1 } }, { a: { _eq: 1 } })).toBe(true)
    expect(jsonEqual({ a: { _eq: 1 } }, { a: { _eq: 2 } })).toBe(false)
    expect(jsonEqual(null, {})).toBe(false)
  })
  it('compares records one level deep by identity', () => {
    expect(shallowRecordEqual({ a: 'x', b: 'y' }, { a: 'x', b: 'y' })).toBe(true)
    expect(shallowRecordEqual({ a: 'x' }, { a: 'x', b: 'y' })).toBe(false)
    expect(shallowRecordEqual({ a: {} }, { a: {} })).toBe(false)
  })
})

describe('keepIfEqual', () => {
  it('keeps the first object while the content is the same', () => {
    const ref: { current: Record<string, unknown> | undefined } = { current: undefined }
    const first = keepIfEqual(ref, { region: { _in: ['1'] } }, jsonEqual)
    expect(keepIfEqual(ref, { region: { _in: ['1'] } }, jsonEqual)).toBe(first)
    const changed = keepIfEqual(ref, { region: { _in: ['2'] } }, jsonEqual)
    expect(changed).not.toBe(first)
    expect(changed).toEqual({ region: { _in: ['2'] } })
  })
})

describe('groupSectionPropsEqual', () => {
  const draft = { a: 1 }
  const onChange = () => {}
  const field = { field: 'a' }
  const base = () => ({
    draft,
    onChange,
    fields: [field],
    visibleFields: new Set(['a']),
    lockedFields: new Set<string>(),
    fieldValues: [1],
    summaryFields: [{ field: 'a', label: 'A' }],
    swapConfig: null,
    onToggle: () => {},
    footerSlot: undefined
  })

  it('skips a render whose rebuilt props hold the same content', () => {
    expect(groupSectionPropsEqual(base(), base())).toBe(true)
  })

  it('renders when anything shown changes', () => {
    expect(groupSectionPropsEqual(base(), { ...base(), draft: { a: 2 } })).toBe(false)
    expect(groupSectionPropsEqual(base(), { ...base(), fieldValues: [2] })).toBe(false)
    expect(groupSectionPropsEqual(base(), { ...base(), lockedFields: new Set(['a']) })).toBe(false)
    expect(
      groupSectionPropsEqual(base(), { ...base(), summaryFields: [{ field: 'b', label: 'B' }] })
    ).toBe(false)
    expect(groupSectionPropsEqual(base(), { ...base(), fields: [{ field: 'a' }] })).toBe(false)
  })

  it('treats the toggle closures by presence and other callbacks by identity', () => {
    expect(groupSectionPropsEqual(base(), { ...base(), onToggle: undefined })).toBe(false)
    expect(groupSectionPropsEqual(base(), { ...base(), onChange: () => {} })).toBe(false)
  })

  it('renders when a prop appears or a React node is rebuilt', () => {
    expect(groupSectionPropsEqual(base(), { ...base(), isOpen: true })).toBe(false)
    expect(groupSectionPropsEqual(base(), { ...base(), footerSlot: {} })).toBe(false)
  })
})
