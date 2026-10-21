import { describe, expect, it } from 'vitest'
import {
  changeNotePolicy,
  changeNoteVersionNote,
  missingChangeNote,
  normalizeChangeNote
} from '../../../services/layout-change-note.js'

describe('layout change note (#2654)', () => {
  it('reads only known policies; anything else is off', () => {
    expect(changeNotePolicy({ change_note: 'note' })).toBe('note')
    expect(changeNotePolicy({ change_note: 'note_ticket' })).toBe('note_ticket')
    expect(changeNotePolicy({ change_note: 'yes' })).toBeNull()
    expect(changeNotePolicy({})).toBeNull()
    expect(changeNotePolicy(null)).toBeNull()
  })

  it('normalizes patch values and refuses unknown ones', () => {
    expect(normalizeChangeNote(null)).toEqual({ value: null })
    expect(normalizeChangeNote('')).toEqual({ value: null })
    expect(normalizeChangeNote('note')).toEqual({ value: 'note' })
    expect(normalizeChangeNote('always')).toHaveProperty('error')
  })

  it('says what a save still lacks', () => {
    expect(missingChangeNote(null, '', '')).toBeNull()
    expect(missingChangeNote('note', '  ', null)).toMatch(/reason/)
    expect(missingChangeNote('note', 'ok', null)).toMatch(/reason/)
    expect(missingChangeNote('note', 'Fix order', null)).toBeNull()
    expect(missingChangeNote('note_ticket', 'Fix order', ' ')).toMatch(/ticket/)
    expect(missingChangeNote('note_ticket', 'Fix order', 'OPS-1')).toBeNull()
  })

  it('builds the version note within the column', () => {
    expect(changeNoteVersionNote('Fix  order', null, 'Move b')).toBe('Fix order — Move b')
    expect(changeNoteVersionNote('Fix', 'https://x/1', '')).toBe('Fix · https://x/1')
    expect(changeNoteVersionNote('', 'T-1', 'Move')).toBeNull()
    const long = changeNoteVersionNote('r'.repeat(200), 't'.repeat(200), 'labels')
    expect(long?.length).toBe(255)
    expect(long?.endsWith('…')).toBe(true)
  })
})
