import { db } from '../../../../db/index.js'

/**
 * The default pin reader (see pins.ts): the versions the Hub has pinned environments and shared
 * deployments to. Read-only; the Docker Hub adapter never imports this file directly.
 */
export async function defaultPinReader(): Promise<string[]> {
  const out = new Set<string>()
  for (const table of ['nivaro_hub_environments', 'nivaro_hub_shared_deployments']) {
    const rows = (await db(table).whereNotNull('version_pin').distinct('version_pin')) as Array<{
      version_pin: unknown
    }>
    for (const r of rows) {
      const v = String(r.version_pin ?? '').trim()
      if (v) out.add(v)
    }
  }
  return [...out]
}
