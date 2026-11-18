import { afterEach, describe, expect, it } from 'vitest'
import {
  describeExportLimit,
  EXPORT_LIMIT_DEFS,
  effectiveExportLimits,
  exportLimit,
  exportLimitValues,
  inMemoryExportRows,
  mergeExportLimitsPatch,
  setStoredExportLimitsForTests
} from '../../../services/export-limits.js'

const ENVS = EXPORT_LIMIT_DEFS.map((d) => d.env)

afterEach(() => {
  for (const e of ENVS) delete process.env[e]
  setStoredExportLimitsForTests(null)
})

describe('export limits', () => {
  it('streamed exports default to no limit; the form export keeps a finite default', () => {
    setStoredExportLimitsForTests({})
    expect(exportLimit('browser_rows')).toBe(Number.POSITIVE_INFINITY)
    // Server-built files stream to disk (services/export-files.ts): no limit by default.
    expect(exportLimit('file_rows')).toBe(Number.POSITIVE_INFINITY)
    expect(exportLimit('preset_rows')).toBe(Number.POSITIVE_INFINITY)
    expect(exportLimit('form_records')).toBe(10_000)
    expect(exportLimit('background_per_person')).toBe(5)
    expect(exportLimitValues()).toMatchObject({
      browser_rows: null,
      file_rows: null,
      preset_rows: null,
      form_records: 10_000
    })
    expect(describeExportLimit('browser_rows')).toBe('every row')
  })

  it('a file built in memory in the request (Ask AI) holds min(request_rows, file_rows)', () => {
    setStoredExportLimitsForTests({})
    expect(inMemoryExportRows()).toBe(50_000)
    // A big background limit never lets the in-memory download grow past the request cap.
    setStoredExportLimitsForTests({ file_rows: 10_000_000 })
    expect(inMemoryExportRows()).toBe(50_000)
    setStoredExportLimitsForTests({ file_rows: 20_000, request_rows: 100_000 })
    expect(inMemoryExportRows()).toBe(20_000)
    setStoredExportLimitsForTests({ request_rows: 5_000 })
    expect(inMemoryExportRows()).toBe(5_000)
  })

  it('an administrator may choose no limit for server files, never for the form export', () => {
    setStoredExportLimitsForTests({ file_rows: 0, form_records: 0 })
    expect(exportLimit('file_rows')).toBe(Number.POSITIVE_INFINITY)
    expect(exportLimit('form_records')).toBe(10_000)
    expect(() => mergeExportLimitsPatch({}, { form_records: 0 })).toThrow(/whole number/)
  })

  it('a stored value beats the default; env beats the stored value', () => {
    setStoredExportLimitsForTests({ file_rows: 20_000 })
    expect(exportLimit('file_rows')).toBe(20_000)
    expect(describeExportLimit('file_rows')).toBe('20,000 rows')
    process.env.EXPORT_FILE_MAX_ROWS = '30000'
    expect(exportLimit('file_rows')).toBe(30_000)
    expect(effectiveExportLimits().find((l) => l.key === 'file_rows')?.source).toBe('env')
  })

  it('env 0 means no limit; junk or out-of-range env is ignored', () => {
    setStoredExportLimitsForTests({ preset_rows: 2_000 })
    process.env.EXPORT_PRESET_MAX_ROWS = '0'
    expect(exportLimit('preset_rows')).toBe(Number.POSITIVE_INFINITY)
    process.env.EXPORT_PRESET_MAX_ROWS = 'lots'
    expect(exportLimit('preset_rows')).toBe(2_000)
    process.env.BACKGROUND_RUNS_PER_PERSON = '0'
    expect(exportLimit('background_per_person')).toBe(5)
  })

  it('merges a patch: numbers set, null clears, bad values refused', () => {
    expect(
      mergeExportLimitsPatch({ file_rows: 5_000 }, { preset_rows: '100,000', file_rows: null })
    ).toEqual({
      preset_rows: 100_000
    })
    expect(mergeExportLimitsPatch({}, { file_rows: 0 })).toEqual({ file_rows: 0 })
    expect(() => mergeExportLimitsPatch({}, { file_rows: 10 })).toThrow(/whole number/)
    expect(() => mergeExportLimitsPatch({}, { background_per_person: 0 })).toThrow(/whole number/)
    expect(() => mergeExportLimitsPatch({}, { nope: 1 })).toThrow(/Unknown export limit/)
  })
})
