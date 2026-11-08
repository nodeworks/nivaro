import { describe, expect, it } from 'vitest'
import { outcomeName, rowActionSentence } from './bulk-copy'
import { csvDateTime, csvNumber, VIRTUAL_HEADERS, virtualExportCell } from './cbv-export'
import { rowDeleteOffered } from './delete-offer'
import { nextSortValue } from './sort-cycle'

// Army 11 (q3): list + bulk wording and offers.

describe('nextSortValue (N6)', () => {
  it('asc → desc → back to the view’s default order', () => {
    expect(nextSortValue('-date_created', 'zone', '-date_created')).toBe('zone')
    expect(nextSortValue('zone', 'zone', '-date_created')).toBe('-zone')
    expect(nextSortValue('-zone', 'zone', '-date_created')).toBe('-date_created')
  })
  it('the default column toggles its two directions', () => {
    expect(nextSortValue('-date_created', 'date_created', '-date_created')).toBe('date_created')
    expect(nextSortValue('date_created', 'date_created', '-date_created')).toBe('-date_created')
  })
  it('no default: the third click clears', () => {
    expect(nextSortValue('-zone', 'zone', '')).toBe('')
  })
})

describe('rowActionSentence (N2)', () => {
  const hold = {
    kind: 'update_fields',
    label: 'Put On Hold',
    summary: 'Sets On hold to Yes',
    confirm_text: 'Marks the selected records on hold. Records already on hold are skipped.'
  }
  it('names the one record, never "the selected records"', () => {
    expect(rowActionSentence(hold, 'MM26-81441')).toBe('Sets On hold to Yes on MM26-81441.')
    expect(
      rowActionSentence({ ...hold, kind: 'extension', summary: 'Extension action' }, 'MM26-81441')
    ).toBe('Marks MM26-81441 on hold. Records already on hold are skipped.')
  })
})

describe('outcomeName (N7)', () => {
  it('server label, else host label, never the row id', () => {
    expect(outcomeName({ item: '372994', label: 'MM26-81441' }, [])).toBe('MM26-81441')
    expect(outcomeName({ item: '372994' }, [{ id: 372994, label: 'MM26-81441' }])).toBe(
      'MM26-81441'
    )
    expect(outcomeName({ item: '372994' }, [{ id: 372994 }])).toBe('A record')
  })
})

describe('rowDeleteOffered (N12)', () => {
  const base = { isAdmin: false, roleMayDelete: true, builtinOpen: true, hasPipeline: true }
  const at = (initial: boolean, moved = false, done = false) => ({
    instance: {
      completed_at: done ? '2026-11-08' : null,
      current_state_obj: { is_initial: initial }
    },
    history: moved ? [{ from_state: 'S0' }] : [{ from_state: null }]
  })
  it('a creator: only a record that never left its first step', () => {
    expect(rowDeleteOffered({ ...base, run: at(true) })).toBe(true)
    expect(rowDeleteOffered({ ...base, run: at(false, true) })).toBe(false)
    expect(rowDeleteOffered({ ...base, run: at(true, true) })).toBe(false)
    expect(rowDeleteOffered({ ...base, run: at(false, true, true) })).toBe(false)
    expect(rowDeleteOffered({ ...base, run: null })).toBe(true)
    expect(rowDeleteOffered({ ...base, run: undefined })).toBe(false)
  })
  it('the Delete built-in and the role decide first; admins always', () => {
    expect(rowDeleteOffered({ ...base, builtinOpen: false, run: at(true) })).toBe(false)
    expect(rowDeleteOffered({ ...base, builtinOpen: undefined, run: at(true) })).toBe(false)
    expect(rowDeleteOffered({ ...base, roleMayDelete: false, run: at(true) })).toBe(false)
    expect(rowDeleteOffered({ ...base, isAdmin: true, builtinOpen: false, run: at(false) })).toBe(
      true
    )
    expect(rowDeleteOffered({ ...base, hasPipeline: false, run: undefined })).toBe(true)
  })
})

describe('list CSV cells (N8)', () => {
  it('numbers as numbers, dates sortable, date-only never shifted', () => {
    expect(csvNumber('3703.68')).toBe(3703.68)
    expect(csvNumber('$3,703.68')).toBe(3703.68)
    expect(csvNumber(12)).toBe(12)
    expect(csvNumber('')).toBe('')
    expect(csvDateTime('2026-11-08')).toBe('2026-11-08')
    expect(csvDateTime('2026-11-08T20:13:00.000Z')).toMatch(/^2026-11-0[89] \d{2}:\d{2}$/)
  })
  it('the State / Owners / Aging / Integrations columns carry what the table shows', () => {
    const extras = {
      instances: {
        '372998': {
          state_label: 'Waiting on Level 1 Approval',
          entered_at: '2026-11-08T12:00:00.000Z'
        }
      },
      owners: { '372998': [{ name: 'Brian Celestine' }, { name: 'Pat Doe' }] },
      addendums: {},
      integrations: { '372998': [{ api: 'LinX', outcome: 'pending' }] },
      tasks: {}
    }
    const now = new Date('2026-11-10T00:00:00.000Z').getTime()
    const cell = (k: Parameters<typeof virtualExportCell>[0]) =>
      virtualExportCell(k, '372998', extras, {}, { now })
    expect(cell('state')).toBe('Waiting on Level 1 Approval')
    expect(cell('aging')).toBe(1.5)
    expect(cell('owners')).toBe('Brian Celestine; Pat Doe')
    expect(String(cell('integrations'))).toMatch(/^LinX: /)
    expect(cell('tasks')).toBe(0)
    expect(VIRTUAL_HEADERS.aging).toBe('Aging (days)')
  })
})
