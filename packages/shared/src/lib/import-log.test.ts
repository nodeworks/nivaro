import { describe, expect, it } from 'vitest'
import { parseImportError, parseImportLog, parseImportLogLine } from './import-log'

const LOG = `Invoice lines: 3,160 new, 3,690 updated, 0 unchanged · base / tax split filled on 92,781 · 456.0s
  compared 99,631 file rows with live data in 14.0s
  skipped 3: no invoice id or line number
  no match for 31 vendor value(s) on 513 rows (the stored value is kept): Pacific Fence Specialists LLC | VOLUNTEER ENERGY COOPERATIVE | WAECO CONSTRUCTION LLC
  no match for 50+ purchase order key value(s) on 34,812 rows (stored without a purchase order, one row per invoice line): 102-300070874-201296 | 102-300075052-201296
  no match for 1 vendor value(s) on 4 rows (the stored value is kept): NOBODY TEST VENDOR LLC
  new invoice lines: 3,160 written in 186.9s
  base / tax split: filled on 92,781 invoice lines in 47.3s (set-based — nothing else on those lines differed, the amount did not change)
  totals: 4,663 purchase orders re-summed in 1.8s
  update_unit_spend: 5.2s`

describe('parseImportLog', () => {
  const log = parseImportLog(LOG)

  it('reads the headline into figures, a sentence and the run time', () => {
    expect(log.time).toBe('456.0s')
    expect(log.headline).toEqual([
      {
        label: 'Invoice lines',
        text: null,
        figures: [
          { value: '3,160', word: 'new' },
          { value: '3,690', word: 'updated' },
          { value: '0', word: 'unchanged' }
        ]
      },
      { label: null, figures: [], text: 'Base / tax split filled on 92,781' }
    ])
  })

  it('reads a headline with no label and groups bare thousands', () => {
    const plain = parseImportLog('789 created, 71 updated, 2232 unchanged')
    expect(plain.headline[0].label).toBe(null)
    expect(plain.headline[0].figures.map((f) => f.value)).toEqual(['789', '71', '2,232'])
    expect(plain.lines).toEqual([])
  })

  it('pulls a trailing duration to the side', () => {
    expect(log.lines[0]).toMatchObject({
      label: 'Compared 99,631 file rows with live data',
      detail: null,
      time: '14.0s'
    })
    expect(log.lines[5]).toMatchObject({
      label: 'New invoice lines',
      detail: '3,160 written',
      time: '186.9s'
    })
    expect(log.lines[7]).toMatchObject({
      label: 'Totals',
      detail: '4,663 purchase orders re-summed',
      time: '1.8s'
    })
  })

  it('keeps a database name as written', () => {
    expect(log.lines[8]).toMatchObject({
      label: 'update_unit_spend',
      detail: null,
      time: '5.2s',
      code: true
    })
  })

  it('finds the duration in front of an aside', () => {
    expect(log.lines[6]).toMatchObject({
      label: 'Base / tax split',
      detail: 'filled on 92,781 invoice lines',
      time: '47.3s',
      note: 'set-based — nothing else on those lines differed, the amount did not change'
    })
  })

  it('splits a value list, its aside and what it left out', () => {
    expect(log.lines[2]).toMatchObject({
      label: 'No match for 31 vendor values on 513 rows',
      note: 'the stored value is kept',
      values: [
        'Pacific Fence Specialists LLC',
        'VOLUNTEER ENERGY COOPERATIVE',
        'WAECO CONSTRUCTION LLC'
      ],
      more: 28
    })
  })

  it('says some are left out when the count is open-ended', () => {
    expect(log.lines[3]).toMatchObject({
      label: 'No match for 50+ purchase order key values on 34,812 rows',
      more: 'some'
    })
  })

  it('lists a single unmatched value as a value', () => {
    expect(log.lines[4]).toMatchObject({
      label: 'No match for 1 vendor value on 4 rows',
      values: ['NOBODY TEST VENDOR LLC'],
      more: null
    })
  })

  it('keeps a reason as a sentence', () => {
    expect(log.lines[1]).toMatchObject({
      label: 'Skipped 3',
      detail: 'no invoice id or line number',
      time: null,
      values: []
    })
  })

  it('marks a line that reports a failure', () => {
    expect(parseImportLogLine('  failed update_unit_spend: Timeout expired')?.problem).toBe(true)
    expect(parseImportLogLine('  new lines: 40 written in 2.0s, 3 FAILED')?.problem).toBe(true)
    expect(parseImportLogLine('  new lines: 40 written in 2.0s')?.problem).toBe(false)
  })

  it('does not mistake a key or a count for a duration', () => {
    expect(parseImportLogLine('  PO 102-300001123 totals')?.time).toBe(null)
    expect(parseImportLogLine('  read 12 rows')?.time).toBe(null)
  })

  it('reads an empty log as nothing', () => {
    expect(parseImportLog('')).toEqual({ headline: [], time: null, lines: [], error: null })
    expect(parseImportLog(null)).toEqual({ headline: [], time: null, lines: [], error: null })
  })
})

describe('a failed run', () => {
  it('separates what ran from the reason', () => {
    const e = parseImportLog(
      "import_units - Conversion failed when converting the nvarchar value '#N/A' to data type int.",
      true
    ).error
    expect(e).toMatchObject({
      source: 'import_units',
      message: "Conversion failed when converting the nvarchar value '#N/A' to data type int.",
      values: []
    })
  })

  it('counts repeated values in a list once', () => {
    const e = parseImportError(
      'import_purchase_orders - Duplicate PO Line Keys: A-1,A-1,A-1,B-2,B-2,C-3'
    )
    expect(e.list_label).toBe('Duplicate PO Line Keys')
    expect(e.values).toEqual([
      { value: 'A-1', count: 3 },
      { value: 'B-2', count: 2 },
      { value: 'C-3', count: 1 }
    ])
    expect(e.message).toBe('')
  })

  it('drops a value the log cut in half and says so', () => {
    const e = parseImportError('import_x - Duplicate Keys: 102-300-1,102-300-1,102-300-2,10')
    expect(e.cut_off).toBe(true)
    expect(e.values).toEqual([
      { value: '102-300-1', count: 2 },
      { value: '102-300-2', count: 1 }
    ])
    expect(parseImportError('import_x - Duplicate Keys: AB-1,CD-22,E').cut_off).toBe(false)
  })

  it('keeps a failed statement apart from an empty reason', () => {
    const e = parseImportError(
      "BULK INSERT staging_purchase_orders FROM 'T:\\ImportFiles\\temp.txt' WITH (FIRSTROW=2, MAXERRORS = 10) - "
    )
    expect(e.source).toBe('staging_purchase_orders')
    expect(e.statement).toMatch(/^BULK INSERT staging_purchase_orders/)
    expect(e.message).toBe('')
  })

  it('takes a reason with no source as the whole message', () => {
    const e = parseImportError('Unsafe column name in staging_invoices: key old')
    expect(e.source).toBe(null)
    expect(e.message).toBe('Unsafe column name in staging_invoices: key old')
    expect(e.values).toEqual([])
  })

  it('still reads a failed run that logged its steps', () => {
    const log = parseImportLog(
      'Lines: 1 new · 2.0s\n  failed update_unit_spend: Timeout expired',
      true
    )
    expect(log.error).toBe(null)
    expect(log.lines[0].problem).toBe(true)
  })
})
