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

export interface RelatedNoteEntry {
  /** Stable id within the provider, e.g. the source row id. */
  id: string | number
  /** Badge text, e.g. the integration's name. */
  label: string
  text: string
  /** A user id when a person wrote it; null for machine events. */
  user?: string | null
  created_at: string | Date
  /** Secondary context line ("Order 12345"). */
  context?: string | null
  /** Optional record the entry belongs to (renders a jump link). */
  link?: { collection: string; item_id: string }
  /** The provider can re-apply this event (#29) — the thread shows a Replay action. */
  replayable?: boolean
  /** Machine status of the event, for the feed's filter (#20): ok | error | info. */
  status?: 'ok' | 'error' | 'info' | null
}

/** A cross-record entry for the integration events feed (#20). */
export interface RelatedNoteFeedEntry extends RelatedNoteEntry {
  collection: string
  item_id: string
  /** Friendly record label when the provider knows one. */
  item_label?: string | null
}

export interface RelatedNoteProvider {
  /** Unique provider id — conventionally `<extension>:<what>`. */
  id: string
  /** The business collection whose threads this provider feeds. */
  collection: string
  /** Human name for the feed's integration filter. */
  label?: string
  load(item: string): Promise<RelatedNoteEntry[]>
  /** #20 — newest entries ACROSS records (a feed page, not a thread). */
  list?(opts: {
    limit: number
    status?: 'ok' | 'error' | 'info' | null
    /** Older-than cursor (ISO) — a provider MAY honour it; the registry
     *  over-fetches and filters regardless, so ignoring it is safe. */
    before?: string | null
  }): Promise<RelatedNoteFeedEntry[]>
  /** #29 — re-fetch / re-apply one event from its stored form. */
  replay?(entryId: string, opts: { userId: string | null }): Promise<{ detail: string }>
}

/**
 * #10 — machine-comment markers. Comment strings written by MACHINERY (an
 * import stamp, a sync script's provenance tag, a proc's marker) are not
 * notes: the thread drops them, the row history renders them as provenance.
 * Which strings those are is a property of whoever writes them, so the
 * writers register them; core knows none by itself.
 */
export interface MachineMarkerSet {
  /** Whole-comment matches, case-insensitive ("legacy-import"). */
  exact?: string[]
  /** Prefix matches, case-insensitive ("forecast-import:"). */
  prefixes?: string[]
}

/** How far back a paged feed call reaches per provider. */
export const LIST_WINDOW = 500

class RelatedNoteRegistry {
  private providers = new Map<string, RelatedNoteProvider>()
  private markers = new Map<string, MachineMarkerSet>()

  /** Declare comment strings an extension's machinery writes (replaces the
   *  owner's previous declaration). */
  registerMachineMarkers(owner: string, set: MachineMarkerSet): void {
    this.markers.set(owner, {
      exact: (set.exact ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean),
      prefixes: (set.prefixes ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean)
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
  describeMarkers(): Array<{ owner: string; exact: string[]; prefixes: string[] }> {
    return [...this.markers.entries()].map(([owner, s]) => ({
      owner,
      exact: s.exact ?? [],
      prefixes: s.prefixes ?? []
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
