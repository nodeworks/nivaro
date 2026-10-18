/**
 * #2154 — offline address → place lookup for the Traffic Map, from an OPTIONAL MaxMind-format
 * database file (GeoLite2-Country or GeoLite2-City `.mmdb`) named by TRAFFIC_GEOIP_DB. Addresses
 * never leave this process: there is no online lookup. Unset, missing or unreadable = no places
 * (the panel says how to enable it).
 *
 * The file is read once (re-read when the path or its mtime changes, checked at most once a
 * minute); lookups go through a bounded per-address cache, so a busy caller costs one tree walk
 * per new address.
 */
import { readFileSync, statSync } from 'node:fs'
import { type CityResponse, Reader } from 'mmdb-lib'
import { isPrivateIp } from './traffic-security.js'

export interface GeoPlace {
  /** ISO country code (`US`), null when the database has none for the address. */
  country: string | null
  country_name: string | null
  /** First subdivision (state / province) — City databases only. */
  region: string | null
  city: string | null
}

const CACHE_CAP = 5000
const RECHECK_MS = 60_000

let reader: Reader<CityResponse> | null = null
let loadedPath: string | null = null
let loadedMtime = 0
let checkedAt = 0
let lastError: string | null = null
let dbType: string | null = null
let builtAt: string | null = null
const cache = new Map<string, GeoPlace | null>()

function load(): void {
  const path = process.env.TRAFFIC_GEOIP_DB?.trim() || null
  const now = Date.now()
  if (path === loadedPath && now - checkedAt < RECHECK_MS) return
  checkedAt = now
  if (!path) {
    reader = null
    loadedPath = null
    lastError = null
    cache.clear()
    return
  }
  try {
    const mtime = statSync(path).mtimeMs
    if (path === loadedPath && mtime === loadedMtime && reader) return
    const r = new Reader<CityResponse>(readFileSync(path))
    reader = r
    loadedPath = path
    loadedMtime = mtime
    lastError = null
    dbType = r.metadata.databaseType ?? null
    builtAt = r.metadata.buildEpoch ? r.metadata.buildEpoch.toISOString() : null
    cache.clear()
  } catch (err) {
    reader = null
    loadedPath = path
    lastError = (err as Error).message?.slice(0, 200) ?? 'unreadable'
    cache.clear()
  }
}

/** Whether lookups work, and why not. */
export function geoStatus(): {
  enabled: boolean
  configured: boolean
  database: string | null
  built_at: string | null
  error: string | null
} {
  load()
  return {
    enabled: !!reader,
    configured: !!process.env.TRAFFIC_GEOIP_DB?.trim(),
    database: dbType,
    built_at: builtAt,
    error: lastError
  }
}

/** The place an address is in; null for private addresses, unknown ones or no database. */
export function lookupPlace(ip: string | null | undefined): GeoPlace | null {
  if (!ip) return null
  load()
  if (!reader) return null
  if (cache.has(ip)) {
    const hit = cache.get(ip) ?? null
    // refresh recency
    cache.delete(ip)
    cache.set(ip, hit)
    return hit
  }
  let place: GeoPlace | null = null
  if (!isPrivateIp(ip)) {
    try {
      const rec = reader.get(ip.startsWith('::ffff:') ? ip.slice(7) : ip)
      const country = rec?.country ?? rec?.registered_country
      if (rec && country?.iso_code) {
        const sub = rec.subdivisions?.[0]
        place = {
          country: country.iso_code,
          country_name: country.names?.en ?? null,
          region: sub?.names?.en ?? sub?.iso_code ?? null,
          city: rec.city?.names?.en ?? null
        }
      }
    } catch {
      place = null
    }
  }
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(ip, place)
  return place
}

/** `US`, `US · Ohio` — the key a place is counted under (country, then region when known). */
export function placeKey(p: GeoPlace): string {
  return p.region ? `${p.country} · ${p.region}` : String(p.country)
}

/** Tests only. */
export function resetGeoForTests(r: Reader<CityResponse> | null = null): void {
  reader = r
  loadedPath = r ? process.env.TRAFFIC_GEOIP_DB?.trim() || null : null
  checkedAt = r ? Number.MAX_SAFE_INTEGER / 2 : 0
  lastError = null
  cache.clear()
}
