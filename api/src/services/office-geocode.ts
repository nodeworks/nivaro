import { db } from '../db/index.js'

/**
 * Resolve a user's Graph-sourced office_location into stored coordinates
 * (office_lat/office_lng, migration 276) so the Command Center people map can
 * pin actual offices instead of region centroids.
 *
 * Resolution order:
 *  1. The locations table — example facilities are already geocoded there, so
 *     a street-line match ("14 Burr St" against address_line_1) is free and
 *     authoritative.
 *  2. Nominatim (OpenStreetMap) — one polite request with a proper User-Agent,
 *     5s budget. Rare by construction: only fires when the address CHANGED
 *     since the last successful geocode (office_geocoded_for watermark).
 *
 * Fire-and-forget from the login path: geocoding must never slow or break a
 * login, and a failed attempt simply retries at the next login.
 */

const inFlight = new Set<string>()

export function queueOfficeGeocode(userId: string): void {
  void geocodeOfficeForUser(userId).catch(() => {})
}

async function geocodeOfficeForUser(userId: string): Promise<void> {
  if (inFlight.has(userId)) return
  inFlight.add(userId)
  try {
    const u = (await db('nivaro_users')
      .where({ id: userId })
      .first('id', 'office_location', 'office_geocoded_for', 'office_lat')) as
      | { office_location: string | null; office_geocoded_for: string | null; office_lat: number | null }
      | undefined
    const addr = (u?.office_location ?? '').trim()
    if (!addr) return
    if (u?.office_geocoded_for === addr && u.office_lat != null) return

    const hit = (await matchKnownLocation(addr)) ?? (await nominatim(addr))
    if (!hit) return
    await db('nivaro_users')
      .where({ id: userId })
      .update({ office_lat: hit.lat, office_lng: hit.lng, office_geocoded_for: addr })
  } finally {
    inFlight.delete(userId)
  }
}

/** Street-line match against the already-geocoded locations table. */
async function matchKnownLocation(addr: string): Promise<{ lat: number; lng: number } | null> {
  const street = addr.split(',')[0]?.trim() ?? ''
  if (street.length < 5) return null
  try {
    const row = (await db('locations')
      .whereRaw('LOWER(LTRIM(RTRIM(address_line_1))) = ?', [street.toLowerCase()])
      .whereNotNull('latitude')
      .whereNot('latitude', 0)
      .first('latitude', 'longitude')) as { latitude: number; longitude: number } | undefined
    if (!row) return null
    const lat = Number(row.latitude)
    const lng = Number(row.longitude)
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
  } catch {
    return null
  }
}

async function nominatim(addr: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(addr)}`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'nivaro-cms office-geocode (ops contact via instance admin)' },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const body = (await res.json()) as Array<{ lat?: string; lon?: string }>
    const lat = Number(body?.[0]?.lat)
    const lng = Number(body?.[0]?.lon)
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
  } catch {
    return null
  }
}
