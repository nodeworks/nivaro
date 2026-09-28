import type {
  ExternalNotificationSourceGroup,
  NotificationSourceProvider
} from '@nivaro/extension-kit'

export type {
  ExternalNotificationSourceGroup,
  ExternalNotificationSourceItem,
  NotificationSourceProvider
} from '@nivaro/extension-kit'

/**
 * Extension-contributed notification sources.
 *
 * The profile's "Notifications & alerts" card aggregates every way the
 * platform can notify a user (/users/me/notification-sources). Extensions
 * that keep their own alert subscriptions (e.g. a deployment's stock-level
 * watches) register a provider here so those subscriptions appear alongside
 * the native ones instead of being invisible to the user.
 */

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
