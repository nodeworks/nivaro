import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'

/**
 * Geocoding (#208): resolve a postal address to lat/lng for the map view.
 * Server-side proxy to OSM Nominatim (respecting its 1 req/s policy via a
 * process-wide gate + 24h in-memory cache) — no API key, no client CORS.
 */

const cache = new Map<string, { lat: number; lng: number; at: number }>()
let lastCall = 0

export async function geocodeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { q?: string } }>(
    '/geocode',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const q = String(req.body?.q ?? '').trim().slice(0, 300)
      if (q.length < 4) return reply.code(400).send({ error: 'Address is too short' })
      const key = q.toLowerCase()
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < 24 * 3600_000) {
        return reply.send({ data: { lat: hit.lat, lng: hit.lng, cached: true } })
      }
      // Nominatim usage policy: max 1 req/s per app.
      const wait = Math.max(0, lastCall + 1100 - Date.now())
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      lastCall = Date.now()
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
          {
            headers: { 'user-agent': 'nivaro-cms/1.0 (geocode field helper)' },
            signal: AbortSignal.timeout(6000)
          }
        )
        const rows = (await res.json()) as Array<{ lat?: string; lon?: string }>
        const first = rows?.[0]
        if (!first?.lat || !first?.lon)
          return reply.code(404).send({ error: 'No match for that address' })
        const out = { lat: Number(first.lat), lng: Number(first.lon), at: Date.now() }
        cache.set(key, out)
        if (cache.size > 2000) cache.delete(cache.keys().next().value as string)
        return reply.send({ data: { lat: out.lat, lng: out.lng, cached: false } })
      } catch {
        return reply.code(502).send({ error: 'Geocoder unreachable' })
      }
    }
  )
}
