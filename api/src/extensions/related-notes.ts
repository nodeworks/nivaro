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
}

export interface RelatedNoteProvider {
  /** Unique provider id — conventionally `<extension>:<what>`. */
  id: string
  /** The business collection whose threads this provider feeds. */
  collection: string
  load(item: string): Promise<RelatedNoteEntry[]>
}

class RelatedNoteRegistry {
  private providers = new Map<string, RelatedNoteProvider>()

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

  /** Every provider's entries for one record, each provider isolated. */
  async load(collection: string, item: string): Promise<RelatedNoteEntry[]> {
    const out: RelatedNoteEntry[] = []
    for (const p of this.forCollection(collection)) {
      try {
        out.push(...(await p.load(item)))
      } catch {
        /* one provider's failure never hides the others */
      }
    }
    return out
  }
}

export const relatedNoteRegistry = new RelatedNoteRegistry()
