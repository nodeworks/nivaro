/**
 * Which image tags a Hub image pin uses (Task 20). A tag a pin names is never deleted
 * (`TAG_PINNED`), so a promote or rollback never points at an image that is gone.
 *
 * The adapter itself never touches the Hub database: it asks a `PinReader`. The default reader
 * (pin-source.ts, the one place this feature reads Hub tables) returns the versions that
 * environments and shared deployments are pinned to; tests set their own. A pin on version `v`
 * covers the tags `v` and `v-slim` of the Hub image repository (`HUB_IMAGE`) and nothing else.
 */

export type PinReader = () => Promise<string[]>

// Hub-only (HUB=on): the pin source, replaced by tests.
let reader: PinReader | null = null

export function setPinReader(fn: PinReader | null): void {
  reader = fn
}

export async function readPins(): Promise<string[]> {
  if (reader) return reader()
  const { defaultPinReader } = await import('./pin-source.js')
  return defaultPinReader()
}

/** `<namespace>/<repository>` as the Hub image repository (HUB_IMAGE, default nodeworks/nivaro). */
export async function isHubImageRepo(namespace: string, repository: string): Promise<boolean> {
  // Loaded on demand: registry.ts pulls in the GitLab client, which would close an import cycle
  // through providers/index.ts back to the engine.
  const { hubImage } = await import('../../registry.js')
  return `${namespace}/${repository}`.toLowerCase() === hubImage().toLowerCase()
}

/** The tags of the Hub image that these pinned versions use. */
export function pinnedTagSet(versions: string[]): Set<string> {
  const out = new Set<string>()
  for (const v of versions) {
    const t = String(v ?? '').trim()
    if (!t) continue
    out.add(t)
    out.add(`${t}-slim`)
  }
  return out
}
