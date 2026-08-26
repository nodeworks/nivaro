import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'

/**
 * Address autocomplete (#518): as-you-type suggestions for the
 * 'address-autocomplete' field interface. Server-side proxy to OSM Nominatim
 * (jsonv2 search, limit 5) with the same 1 req/s process-wide pacing gate the
 * sibling /geocode route uses, a 10-minute in-process cache per query, and a
 * FAIL-SILENT contract — a slow/unreachable geocoder returns an empty list,
 * never an error the typing UI would have to surface.
 *
 * Registered as its own plugin (sibling to geocodeRoutes) — orchestrator wires
 * it in routes/index.ts:
 *   import { geocodeSuggestRoutes } from './geocode-suggest.js'
 *   await app.register(geocodeSuggestRoutes)
 */

type Suggestion = { display_name: string; lat?: string; lon?: string }

const cache = new Map<string, { rows: Suggestion[]; at: number }>()
const CACHE_TTL_MS = 10 * 60_000
let lastCall = 0

export async function geocodeSuggestRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { q?: string } }>(
    '/geocode/suggest',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const q = String(req.body?.q ?? '').trim().slice(0, 300)
      if (q.length < 4) return reply.send({ data: [] })
      const key = q.toLowerCase()
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return reply.send({ data: hit.rows })
      }
      // Nominatim usage policy: max 1 req/s per app (shared pacing intent with
      // /geocode; each keeps its own gate — worst case is a brief 2 req/s
      // burst, acceptable for an authenticated internal field helper).
      const wait = Math.max(0, lastCall + 1100 - Date.now())
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      lastCall = Date.now()
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`,
          {
            headers: { 'user-agent': 'nivaro-cms address-field' },
            signal: AbortSignal.timeout(5000)
          }
        )
        if (!res.ok) return reply.send({ data: [] })
        const raw = (await res.json()) as Array<{
          display_name?: string
          lat?: string
          lon?: string
        }>
        const rows: Suggestion[] = (Array.isArray(raw) ? raw : [])
          .filter((r) => typeof r.display_name === 'string' && r.display_name)
          .slice(0, 5)
          .map((r) => ({ display_name: r.display_name as string, lat: r.lat, lon: r.lon }))
        cache.set(key, { rows, at: Date.now() })
        if (cache.size > 2000) cache.delete(cache.keys().next().value as string)
        return reply.send({ data: rows })
      } catch {
        // Fail silent — suggestions are an assist, never a blocker.
        return reply.send({ data: [] })
      }
    }
  )
}
