import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { memo } from '../overview/data.js'

/**
 * Command Center partners strip (CC-14) — administrators only. One row per enabled external
 * API from the Integrations console's own partner cards (GET /api/integration-partners, asked
 * in-process AS THE ADMIN who is looking — their own credential, never a stored one), plus the
 * count of open Firefight problems naming that partner (nivaro_integration_signal_rows still
 * open — snoozed or dismissed ones still count here; the console itself hides them).
 */

export interface PartnerHealthRow {
  key: string
  label: string
  status: 'ok' | 'degraded' | 'down' | 'unknown'
  open_problems: number
  last_ok_at: string | null
  href: string | null
}

interface CardLike {
  id: number
  name: string
  enabled: boolean
  health: 'healthy' | 'degraded' | 'failing' | 'idle'
  last_ok_at: string | null
}

/** Console health word → strip status. Idle (no calls in 24 h) = unknown, never "ok". Pure. */
export function partnerStatus(h: CardLike['health']): PartnerHealthRow['status'] {
  return h === 'healthy'
    ? 'ok'
    : h === 'degraded'
      ? 'degraded'
      : h === 'failing'
        ? 'down'
        : 'unknown'
}

const RANK = { down: 0, degraded: 1, unknown: 2, ok: 3 } as const

/** Cards + open problems → strip rows, worst first. Pure. */
export function partnerRows(cards: CardLike[], problems: Map<string, number>): PartnerHealthRow[] {
  return cards
    .filter((c) => c.enabled)
    .map((c) => ({
      key: String(c.id),
      label: c.name,
      status: partnerStatus(c.health),
      open_problems: problems.get(c.name.toLowerCase()) ?? 0,
      last_ok_at: c.last_ok_at,
      href: '/integration-health?tab=partners'
    }))
    .sort(
      (a, b) =>
        RANK[a.status] - RANK[b.status] ||
        b.open_problems - a.open_problems ||
        a.label.localeCompare(b.label)
    )
}

/** Open Firefight problems per partner name (lower-cased), from the stored signal rows. */
async function openProblemsByPartner(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const rows = (await db('nivaro_integration_signal_rows')
    .whereNull('cleared_at')
    .orderBy('id', 'desc')
    .limit(2000)
    .select('payload')
    .catch(() => [])) as Array<{ payload: string | null }>
  for (const r of rows) {
    try {
      const api = (JSON.parse(String(r.payload ?? '{}')) as { api?: unknown }).api
      if (typeof api === 'string' && api) {
        const k = api.toLowerCase()
        out.set(k, (out.get(k) ?? 0) + 1)
      }
    } catch {
      /* a malformed payload names no partner */
    }
  }
  return out
}

export async function readPartners(
  app: FastifyInstance,
  req: FastifyRequest
): Promise<PartnerHealthRow[]> {
  if (!req.isAdmin) return []
  // The same for every administrator of this tenant: one read per minute.
  return memo('cc:partners', 60_000, async () => {
    const headers: Record<string, string> = {}
    if (req.headers.authorization) headers.authorization = String(req.headers.authorization)
    if (req.headers.cookie) headers.cookie = String(req.headers.cookie)
    const res = await app.inject({ method: 'GET', url: '/api/integration-partners', headers })
    if (res.statusCode !== 200) throw new Error(`integration-partners answered ${res.statusCode}`)
    const cards = ((res.json() as { data?: { partners?: CardLike[] } }).data?.partners ??
      []) as CardLike[]
    return partnerRows(cards, await openProblemsByPartner())
  })
}
