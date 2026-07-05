import type { QueueItemRow } from '@/pages/QueueDetail'

export interface QueueGroup {
  key: string
  rows: QueueItemRow[]
  breached: number
  atRisk: number
}

export function agingBucket(hours: number | null): string {
  if (hours == null) return 'unknown'
  if (hours < 24) return '<1d'
  if (hours < 72) return '1–3d'
  if (hours < 168) return '3–7d'
  return '>7d'
}

export function deriveGroupKey(row: QueueItemRow, attribute: string): string {
  if (attribute === 'state') return row.state ?? 'No state'
  if (attribute === 'collection') return row.collection
  if (attribute === 'sla_status') return row.sla_status ?? '—'
  if (attribute === 'at_risk') return row.at_risk ? 'At risk' : 'Not at risk'
  if (attribute === 'owners') {
    return row.owners.length ? row.owners.map((o) => o.name).join(', ') : 'No owners'
  }
  if (attribute === 'aging') return agingBucket(row.aging_hours)
  if (attribute.startsWith('extra.')) {
    const value = row.extra?.[attribute.slice('extra.'.length)]
    return value == null || value === '' ? '—' : String(value)
  }
  return '—'
}

// Fixed semantic orders; anything not listed falls back to count-desc.
const FIXED_ORDERS: Record<string, string[]> = {
  sla_status: ['breached', 'warning', 'ok', '—'],
  at_risk: ['At risk', 'Not at risk'],
  aging: ['>7d', '3–7d', '1–3d', '<1d', 'unknown']
}

// Keys always ordered last within count-desc attributes.
const LAST_KEYS = new Set(['No owners'])

export function buildGroups(rows: QueueItemRow[], attribute: string): QueueGroup[] {
  const map = new Map<string, QueueGroup>()
  for (const row of rows) {
    const key = deriveGroupKey(row, attribute)
    const group = map.get(key) ?? { key, rows: [], breached: 0, atRisk: 0 }
    group.rows.push(row)
    if (row.sla_status === 'breached') group.breached++
    if (row.at_risk) group.atRisk++
    map.set(key, group)
  }
  const groups = [...map.values()]
  const fixed = FIXED_ORDERS[attribute]
  if (fixed) {
    groups.sort((a, b) => fixed.indexOf(a.key) - fixed.indexOf(b.key))
  } else {
    groups.sort((a, b) => {
      const aLast = LAST_KEYS.has(a.key) ? 1 : 0
      const bLast = LAST_KEYS.has(b.key) ? 1 : 0
      if (aLast !== bLast) return aLast - bLast
      return b.rows.length - a.rows.length
    })
  }
  return groups
}
