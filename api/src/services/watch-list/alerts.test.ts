import { describe, expect, it } from 'vitest'
import {
  type AlertEntry,
  addAlert,
  afterFiring,
  alertText,
  fieldAlertsToFire,
  indexAlerts,
  overdueAlertsToFire,
  removeAlert,
  stepAlertsToFire
} from './alerts.js'
import { normalizeWatchList, type WatchAlert } from './store.js'

const T0 = new Date('2026-11-14T10:00:00Z')
const pinned = () =>
  normalizeWatchList({ pins: [{ c: 'orders', id: '5', at: '2026-11-01T00:00:00Z' }] })

const rule = (over: Partial<WatchAlert>): WatchAlert => ({
  id: 'abcd1234',
  c: 'orders',
  rid: '5',
  kind: 'field',
  repeat: false,
  at: T0.toISOString(),
  ...over
})

describe('watch list alert rules', () => {
  it('adds a rule only on a pinned record, once per kind and target', () => {
    const notPinned = addAlert(normalizeWatchList(undefined), {
      collection: 'orders',
      id: '5',
      kind: 'overdue'
    })
    expect(notPinned).toMatchObject({ ok: false, code: 'NOT_PINNED' })

    const r = addAlert(pinned(), {
      collection: 'orders',
      id: '5',
      kind: 'step',
      step: 'approved',
      label: 'Approved',
      repeat: true
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.alert).toMatchObject({
      kind: 'step',
      step: 'approved',
      label: 'Approved',
      repeat: true
    })
    const again = addAlert(r.list, {
      collection: 'orders',
      id: '5',
      kind: 'step',
      step: 'approved'
    })
    expect(again).toMatchObject({ ok: false, code: 'ALERT_EXISTS' })
    expect(
      addAlert(r.list, { collection: 'orders', id: '5', kind: 'field', field: 'bad field' })
    ).toMatchObject({ ok: false, code: 'BAD_ALERT' })
    expect(removeAlert(r.list, r.alert.id).list.alerts).toEqual([])
  })

  it('a field rule fires on a change by someone else, never on the person’s own', () => {
    const entries: AlertEntry[] = [
      { user: 'u-1', alert: rule({ field: 'amount' }) },
      { user: 'u-2', alert: rule({ id: 'abcd1235', field: 'amount' }) },
      { user: 'u-3', alert: rule({ id: 'abcd1236', field: 'vendor' }) }
    ]
    const fire = fieldAlertsToFire(entries, new Set(['amount']), 'U-1')
    expect(fire.map((e) => e.user)).toEqual(['u-2'])
  })

  it('a step rule fires when the record arrives on that step (any case), not on own moves', () => {
    const entries: AlertEntry[] = [
      { user: 'u-1', alert: rule({ kind: 'step', step: 'Approved', field: undefined }) },
      { user: 'u-2', alert: rule({ id: 'abcd1235', kind: 'step', step: 'approved' }) },
      { user: 'u-3', alert: rule({ id: 'abcd1236', kind: 'step', step: 'rejected' }) }
    ]
    expect(stepAlertsToFire(entries, 'approved', 'u-2').map((e) => e.user)).toEqual(['u-1'])
    expect(stepAlertsToFire(entries, null, null)).toEqual([])
  })

  it('an overdue rule fires once per breach', () => {
    const due = '2026-11-14T09:00:00.000Z'
    const entries: AlertEntry[] = [
      { user: 'u-1', alert: rule({ kind: 'overdue' }) },
      { user: 'u-2', alert: rule({ id: 'abcd1235', kind: 'overdue', due }) },
      { user: 'u-3', alert: rule({ id: 'abcd1236', kind: 'overdue', rid: '6' }) }
    ]
    const sla = {
      '5': { status: 'breached', due_at: due },
      '6': { status: 'ok', due_at: '2026-11-15T09:00:00.000Z' }
    }
    const fire = overdueAlertsToFire(entries, sla, T0.getTime())
    expect(fire.map((e) => [e.user, e.due])).toEqual([['u-1', due]])
  })

  it('a once-rule goes after firing; an every-time rule remembers when and which breach', () => {
    const l = normalizeWatchList({
      pins: [{ c: 'orders', id: '5' }],
      alerts: [
        { id: 'abcd1234', c: 'orders', rid: '5', kind: 'overdue' },
        { id: 'abcd1235', c: 'orders', rid: '5', kind: 'step', step: 'x', repeat: true }
      ]
    })
    expect(afterFiring(l, 'abcd1234', T0)?.alerts.map((a) => a.id)).toEqual(['abcd1235'])
    const kept = afterFiring(l, 'abcd1235', T0, '2026-11-14T09:00:00.000Z')
    expect(kept?.alerts.find((a) => a.id === 'abcd1235')).toMatchObject({
      fired: T0.toISOString(),
      due: '2026-11-14T09:00:00.000Z'
    })
    expect(afterFiring(l, 'gone', T0)).toBeNull()
  })

  it('indexes rules by record and words the alert without values', () => {
    const people = new Map([
      [
        'u-1',
        normalizeWatchList({
          pins: [{ c: 'orders', id: '5' }],
          alerts: [{ id: 'abcd1234', c: 'orders', rid: '5', kind: 'field', field: 'amount' }]
        })
      ]
    ])
    expect(indexAlerts(people).get('orders:5')).toHaveLength(1)
    const t = alertText(rule({ field: 'amount' }), 'PO 12', {
      fieldLabel: 'Amount',
      actorName: 'Beth Lee'
    })
    expect(t.subject).toBe('Watch list: Amount changed on PO 12')
    expect(t.message).toContain('Beth Lee changed Amount on PO 12')
    expect(t.message).toContain('now off')
  })
})
