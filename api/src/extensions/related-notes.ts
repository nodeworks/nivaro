import type {
  MachineMarkerSet,
  RelatedNoteEntry,
  RelatedNoteFeedEntry,
  RelatedNoteProvider
} from '@nivaro/extension-kit'

export type {
  MachineMarkerSet,
  RelatedNoteEntry,
  RelatedNoteFeedEntry,
  RelatedNoteProvider
} from '@nivaro/extension-kit'
/**
 * Related-notes sources (2026-09-14) — extensions add read-only entries to a
 * record's Notes thread (`GET /comments/related`) beside transition comments,
 * change reasons and addendum reasons — e.g. an integration's shipment or
 * sync events — so the record's history lives in one place.
 *
 * A provider is keyed by the collection it speaks for; `load` runs per
 * thread read AS THE ROUTE (the caller already passed the record read gate),
 * so providers must never widen what the record itself exposes. Failures are
 * swallowed by the route — a broken provider never takes the thread down.
 */

/** How far back a paged feed call reaches per provider. */
export const LIST_WINDOW = 500

class RelatedNoteRegistry {
  private providers = new Map<string, RelatedNoteProvider>()
  private markers = new Map<string, MachineMarkerSet>()

  /** Declare comment strings an extension's machinery writes (replaces the
   *  owner's previous declaration). */
  registerMachineMarkers(owner: string, set: MachineMarkerSet): void {
    const labels: Record<string, string> = {}
    for (const [k, v] of Object.entries(set.labels ?? {})) {
      const key = String(k).trim().toLowerCase()
      if (key && typeof v === 'string' && v.trim()) labels[key] = v.trim().slice(0, 120)
    }
    this.markers.set(owner, {
      exact: (set.exact ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
      prefixes: (set.prefixes ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
      labels
    })
  }

  unregisterMachineMarkers(owner: string): void {
    this.markers.delete(owner)
  }

  /** Is this comment a registered machine marker (never a human note)? */
  isMachineComment(text: string | null | undefined): boolean {
    const t = String(text ?? '')
      .trim()
      .toLowerCase()
    if (t === '') return false
    for (const set of this.markers.values()) {
      if (set.exact?.includes(t)) return true
      if (set.prefixes?.some((p) => t.startsWith(p))) return true
    }
    return false
  }

  /** Every declared marker, by owner — the registry page and the client's
   *  provenance renderer read this. */
  describeMarkers(): Array<{
    owner: string
    exact: string[]
    prefixes: string[]
    labels: Record<string, string>
  }> {
    return [...this.markers.entries()].map(([owner, s]) => ({
      owner,
      exact: s.exact ?? [],
      prefixes: s.prefixes ?? [],
      labels: s.labels ?? {}
    }))
  }

  register(provider: RelatedNoteProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Related-notes provider "${provider.id}" already registered`)
    }
    this.providers.set(provider.id, provider)
  }

  unregister(id: string): void {
    this.providers.delete(id)
  }

  forCollection(collection: string): RelatedNoteProvider[] {
    return [...this.providers.values()].filter((p) => p.collection === collection)
  }

  get(id: string): RelatedNoteProvider | undefined {
    return this.providers.get(id)
  }

  /** Every provider, without handlers — the feed page's integration filter. */
  describe(): Array<{
    id: string
    collection: string
    label: string
    can_list: boolean
    can_replay: boolean
  }> {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      collection: p.collection,
      label: p.label ?? p.id,
      can_list: typeof p.list === 'function',
      can_replay: typeof p.replay === 'function'
    }))
  }

  /**
   * #20 — newest entries across every provider that can list, each isolated.
   * `before` pages backwards: entries strictly older than it. Providers list
   * newest-first with no cursor contract of their own, so a paged call asks
   * each for the feed's full window (LIST_WINDOW) and filters here — the feed
   * therefore reaches back LIST_WINDOW entries per provider, no further.
   */
  async listRecent(opts: {
    limit: number
    provider?: string | null
    status?: 'ok' | 'error' | 'info' | null
    before?: string | null
  }): Promise<Array<RelatedNoteFeedEntry & { provider: string }>> {
    const beforeMs = opts.before ? new Date(opts.before).getTime() : Number.NaN
    const paged = Number.isFinite(beforeMs)
    const out: Array<RelatedNoteFeedEntry & { provider: string }> = []
    for (const p of this.providers.values()) {
      if (!p.list) continue
      if (opts.provider && p.id !== opts.provider) continue
      try {
        const rows = await p.list({
          limit: paged ? LIST_WINDOW : opts.limit,
          status: opts.status ?? null,
          before: paged ? new Date(beforeMs).toISOString() : null
        })
        out.push(...rows.map((r) => ({ ...r, provider: p.id })))
      } catch {
        /* one provider's failure never hides the others */
      }
    }
    return out
      .filter((r) => !paged || new Date(r.created_at).getTime() < beforeMs)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, opts.limit)
  }

  /** Every provider's entries for one record, each provider isolated. */
  async load(
    collection: string,
    item: string
  ): Promise<Array<RelatedNoteEntry & { provider: string }>> {
    const out: Array<RelatedNoteEntry & { provider: string }> = []
    for (const p of this.forCollection(collection)) {
      try {
        const rows = await p.load(item)
        out.push(
          ...rows.map((r) => ({
            ...r,
            provider: p.id,
            replayable: r.replayable === true && typeof p.replay === 'function'
          }))
        )
      } catch {
        /* one provider's failure never hides the others */
      }
    }
    return out
  }
}

export const relatedNoteRegistry = new RelatedNoteRegistry()

// The one machine string core itself writes as a change reason: a create the
// natural-key upsert turned into an update (services/items.ts createOne).
relatedNoteRegistry.registerMachineMarkers('core', {
  exact: ['Natural-key upsert (create matched an existing record)'],
  // Writes a transition action made (services/action-writes.ts, #818).
  prefixes: ['transition-action:'],
  labels: {
    'natural-key upsert (create matched an existing record)': 'Matched an existing record on import'
  }
})
