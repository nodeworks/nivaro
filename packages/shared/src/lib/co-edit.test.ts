// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyFieldEditing,
  bindRecordCoEdit,
  FIELD_POINT_OUT,
  pointCoViewer,
  pointMayScroll,
  pointRefusalText,
  resetCoEditForTests,
  sectionPresence,
  sectionPresenceText
} from './co-edit'

afterEach(() => resetCoEditForTests())

const beth = { id: 'B1', name: 'Beth Ames' }
const kim = { id: 'K1', name: 'Kim Lo' }

describe('co-edit — section presence (rt7 #3)', () => {
  it('folds field:editing in and out, never the viewer themselves', () => {
    let e = applyFieldEditing({}, { field: 'amount', user: beth }, 'ME')
    expect(e.amount?.name).toBe('Beth Ames')
    expect(applyFieldEditing(e, { field: 'amount', user: beth }, 'ME')).toBe(e)
    e = applyFieldEditing(e, { field: 'amount', user: null }, 'ME')
    expect(e).toEqual({})
    expect(applyFieldEditing({}, { field: 'x', user: { id: 'me', name: 'Me' } }, 'ME')).toEqual({})
  })

  it('counts only the section fields on this form and its line grids', () => {
    const editing = {
      amount: beth,
      secret: kim,
      'cell:order_lines:7:qty': kim,
      'row:other_lines:2': beth
    }
    const people = sectionPresence(editing, new Set(['amount', 'status']), new Set(['order_lines']))
    expect(people.map((p) => p.name)).toEqual(['Beth Ames', 'Kim Lo'])
    expect(sectionPresence(editing, new Set(['status']))).toEqual([])
    expect(sectionPresenceText([beth], 'Shipping')).toBe('Beth Ames is in Shipping')
    expect(sectionPresenceText([beth, kim], 'Shipping')).toBe(
      'Beth Ames and Kim Lo are in Shipping'
    )
  })
})

describe('co-edit — pointing (rt7 #4)', () => {
  it('scrolls only for an idle, visible, Normal-mode viewer', () => {
    const base = {
      quiet: false,
      visible: true,
      editingSomething: false,
      popoverOpen: false,
      lastInputAt: 0,
      now: 20_000
    }
    expect(pointMayScroll(base)).toBe(true)
    expect(pointMayScroll({ ...base, quiet: true })).toBe(false)
    expect(pointMayScroll({ ...base, editingSomething: true })).toBe(false)
    expect(pointMayScroll({ ...base, popoverOpen: true })).toBe(false)
    expect(pointMayScroll({ ...base, visible: false })).toBe(false)
    expect(pointMayScroll({ ...base, lastInputAt: 19_000 })).toBe(false)
  })

  it('says why a nudge did not go', () => {
    expect(pointRefusalText('gone', 'Beth')).toBe('Beth is no longer on this record')
    expect(pointRefusalText('field', 'Beth')).toBe("Beth can't see this field")
  })

  it('carries a nudge out through the host socket and back in', () => {
    const handlers = new Map<string, (p: any) => void>()
    const socket = {
      on: (ev: string, cb: (p: any) => void) => handlers.set(ev, cb),
      off: (ev: string) => handlers.delete(ev),
      emit: vi.fn()
    }
    const off = bindRecordCoEdit(socket, 'orders', '5', 'ME')
    const seen: unknown[] = []
    window.addEventListener(FIELD_POINT_OUT, (e) => seen.push((e as CustomEvent).detail))
    pointCoViewer('orders', 5, 'amount', 'B1')
    expect(socket.emit).toHaveBeenCalledWith(
      'field:point',
      expect.objectContaining({ collection: 'orders', item: '5', field: 'amount', to: 'B1' })
    )
    // Another record's nudge is not this one's.
    pointCoViewer('orders', 6, 'amount', 'B1')
    expect(socket.emit).toHaveBeenCalledTimes(1)
    expect(seen.length).toBe(2)
    off()
    expect(handlers.size).toBe(0)
  })
})
