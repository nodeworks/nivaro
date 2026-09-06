/**
 * Extension-contributed notification sources.
 *
 * The profile's "Notifications & alerts" card aggregates every way the
 * platform can notify a user (/users/me/notification-sources). Extensions
 * that keep their own alert subscriptions (e.g. EFP's warehouse stock
 * watches) register a provider here so those subscriptions appear alongside
 * the native ones instead of being invisible to the user.
 */

export interface ExternalNotificationSourceItem {
  id: string | number
  /** What the user is watching, e.g. "CIFA 26824 · PAE77". */
  label: string
  /** Secondary line, e.g. "alert when on-hand < 50". */
  detail?: string | null
  is_active?: boolean
}

export interface ExternalNotificationSourceGroup {
  /** Stable key, unique per provider (e.g. 'stock-watches'). */
  key: string
  /** Card section title, e.g. "Stock Planning watches". */
  title: string
  description?: string
  /** Where the user manages these (the card renders a Manage link). */
  manage_url?: string
  items: ExternalNotificationSourceItem[]
}

export interface NotificationSourceProvider {
  /** Unique provider id — conventionally the extension id. */
  id: string
  fetch(userId: string): Promise<ExternalNotificationSourceGroup[]>
}

class NotificationSourceRegistry {
  private providers = new Map<string, NotificationSourceProvider>()

  register(provider: NotificationSourceProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Notification source provider "${provider.id}" already registered`)
    }
    this.providers.set(provider.id, provider)
  }

  unregister(id: string): void {
    this.providers.delete(id)
  }

  /** Collect all providers' groups for a user — a broken provider is skipped,
   *  never allowed to take the whole notification-sources payload down. */
  async collect(userId: string): Promise<ExternalNotificationSourceGroup[]> {
    const out: ExternalNotificationSourceGroup[] = []
    for (const p of this.providers.values()) {
      try {
        out.push(...(await p.fetch(userId)))
      } catch {
        /* provider error — the rest still render */
      }
    }
    return out
  }
}

export const notificationSourceRegistry = new NotificationSourceRegistry()
