export interface NotificationChannelDef {
  id: string
  label: string
  /** Called for each notification that should be delivered via this channel. */
  deliver(ctx: NotificationDeliveryContext): Promise<void>
}

export interface NotificationDeliveryContext {
  recipient: string
  subject: string
  message: string
  collection?: string
  item?: string | number
  sender?: string
}

class NotificationChannelRegistry {
  private channels = new Map<string, NotificationChannelDef>()

  register(def: NotificationChannelDef): void {
    if (this.channels.has(def.id)) {
      throw new Error(`Notification channel "${def.id}" already registered`)
    }
    this.channels.set(def.id, def)
  }

  unregister(id: string): void {
    this.channels.delete(id)
  }

  list(): NotificationChannelDef[] {
    return [...this.channels.values()]
  }

  get(id: string): NotificationChannelDef | undefined {
    return this.channels.get(id)
  }

  /** Deliver to all registered channels — errors are logged, not thrown. */
  async deliverAll(
    ctx: NotificationDeliveryContext,
    logger?: { error: (o: unknown, m: string) => void }
  ): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.deliver(ctx)
      } catch (err) {
        logger?.error({ err, channel: channel.id }, 'Notification channel delivery failed')
      }
    }
  }
}

export const notificationChannelRegistry = new NotificationChannelRegistry()
