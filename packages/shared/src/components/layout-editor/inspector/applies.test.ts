import { describe, expect, it } from 'vitest'
import {
  RAW_OPTION_SCOPE,
  showsDateMode,
  showsInputMask,
  showsNumbers,
  showsRawOption
} from './applies'

type K = Parameters<typeof showsNumbers>[0]
const f = (over: Partial<K>): K => ({
  type: 'string',
  relKind: null,
  isPath: false,
  iface: 'input',
  ...over
})

const M2O = f({ type: 'integer', relKind: 'M2O', iface: 'relation-picker' })
const O2M_GRID = f({ type: 'string', relKind: 'O2M', iface: 'inline-table' })
const BOOL = f({ type: 'boolean', iface: 'toggle' })
const DECIMAL = f({ type: 'decimal' })
const TEXT = f({ type: 'string' })
const PATH = f({ type: 'string', isPath: true })
const DUE = f({ type: 'datetime', iface: 'datetime' })

describe('inspector settings by field kind', () => {
  it('Numbers only for a plain number field (not its M2O key)', () => {
    expect(showsNumbers(DECIMAL)).toBe(true)
    expect(showsNumbers(M2O)).toBe(false)
    expect(showsNumbers(O2M_GRID)).toBe(false)
    expect(showsNumbers(BOOL)).toBe(false)
  })

  it('Input mask only for typed text', () => {
    expect(showsInputMask(TEXT)).toBe(true)
    expect(showsInputMask(O2M_GRID)).toBe(false)
    expect(showsInputMask(M2O)).toBe(false)
    expect(showsInputMask(PATH)).toBe(false)
    expect(showsInputMask(BOOL)).toBe(false)
  })

  it('Date mode only for dates', () => {
    expect(showsDateMode(DUE)).toBe(true)
    expect(showsDateMode(TEXT)).toBe(false)
  })

  it('grid and picker raw options stay off a yes / no field', () => {
    for (const key of Object.keys(RAW_OPTION_SCOPE))
      expect(showsRawOption(key, BOOL, undefined), key).toBe(false)
    expect(showsRawOption('row_filter', O2M_GRID, undefined)).toBe(true)
    expect(showsRawOption('row_bulk_actions', O2M_GRID, undefined)).toBe(true)
    expect(showsRawOption('picker_facets', M2O, undefined)).toBe(true)
    expect(showsRawOption('option_filter', M2O, undefined)).toBe(true)
    expect(showsRawOption('row_filter', M2O, undefined)).toBe(false)
  })

  it('a value stored where it does not belong still shows, so it can be seen and removed', () => {
    expect(showsRawOption('row_filter', BOOL, { a: 1 })).toBe(true)
  })
})
