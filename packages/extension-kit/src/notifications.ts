export type NotifyCategory =
  | 'mentions'
  | 'workflow'
  | 'sla'
  | 'watch'
  | 'alerts'
  | 'anomaly'
  | 'reports'
  | 'integrations'
  | 'system'
  | 'other'

export type NotificationKind =
  | 'record'
  | 'task'
  | 'approval'
  | 'access_request'
  | 'sla'
  | 'chat'
  | 'queue'
  | 'report'
  | 'alerts'
  | 'issue'
  | 'import'
  | 'dashboard'
  | 'my_work'
  | 'home'
  | 'external'
  | 'integration'

export type NotificationAction =
  | 'open'
  | 'complete'
  | 'acknowledge'
  | 'review'
  | 'approve'
  | 'reply'

/** What a notification is ABOUT, and what clicking it should do. */
export interface NotificationTargetSpec {
  kind: NotificationKind
  /** record / sla: the record. approval: the approval's record. */
  collection?: string | null
  /** record id, task id, approval instance id, queue / report / dashboard id. */
  id?: string | number | null
  /** chat: room key. */
  room?: string | null
  /** record: query string appended (addendum=…, layout=…). */
  query?: string | null
  /** record: field to focus / tab to open on arrival. */
  focus?: string | null
  tab?: string | null
  /** external: absolute URL. */
  url?: string | null
  /** The primary thing a click should offer. Default 'open'. */
  action?: NotificationAction
  /** Extra ids the action needs (task id for a record-kind row, …). */
  task_id?: string | number | null
  instance_id?: string | number | null
}

/** `nivaro_notifications.detail` — what the row is about beyond subject +
 *  message. Diagnostic and explanatory only; never drives delivery. */
export interface NotificationDetail {
  changes?: Array<{ field: string; label: string; old: string; new: string }>
  via_child?: {
    collection: string
    item: string
    event: string
    label?: string | null
  } | null
  bundle?: { writes: number; children: string[] } | null
  why?: {
    kind: string
    text: string
    label?: string | null
    id?: string | number | null
  } | null
}

export interface NotifyUserOptions {
  subject: string
  message: string
  collection?: string | null
  item?: string | null
  sender?: string | null
  /** Defaults: inapp true, email false, sms false. */
  channels?: { inapp?: boolean; email?: boolean; sms?: boolean }
  /** Explicit notification-rules category; otherwise sniffed from the subject. */
  category?: NotifyCategory
  /** Skip the two "you already know" suppressions — record mutes and
   *  presence-aware suppression — so the inbox row ALWAYS lands. The matrix,
   *  quiet hours and suspended/redacted skips still apply. */
  always_inbox?: boolean
  /** Dedicated Liquid template for the EMAIL channel (default 'notification'). */
  template?: string
  template_data?: Record<string, unknown>
  /** Footer "You're getting this because …". */
  why?: string | null
  /** What the notification is about + what a click should offer. Defaults to
   *  the record named by collection + item. */
  target?: NotificationTargetSpec | null
  /** What produced this row (the bell's "why me?"). */
  source?: { kind: string; label?: string | null; id?: string | number | null } | null
  /** Structured content stored with the row. */
  detail?: Omit<NotificationDetail, 'why'> | null
  /** Internal: set on outbox re-deliveries to prevent re-enqueue loops. */
  _retry?: boolean
}

export interface NotificationDeliveryContext {
  recipient: string
  subject: string
  message: string
  collection?: string
  item?: string | number
  sender?: string
}

/** A custom delivery channel (SMS, Slack, Teams…). */
export interface NotificationChannelDef {
  id: string
  label: string
  /** Called for each notification that should be delivered via this channel. */
  deliver(ctx: NotificationDeliveryContext): Promise<void>
}

export interface ExternalNotificationSourceItem {
  id: string | number
  /** What the user is watching, e.g. "Part 26824 · Main warehouse". */
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

/** Contributes extension-owned subscriptions to the profile's
 *  notification-sources card. */
export interface NotificationSourceProvider {
  /** Unique provider id — conventionally the extension id. */
  id: string
  fetch(userId: string): Promise<ExternalNotificationSourceGroup[]>
}

export interface DigestLine {
  text: string
  sub?: string | null
  url?: string | null
}

export interface DigestSection {
  title: string
  lines: DigestLine[]
}

/** A per-user section of the daily action digest email; null = nothing today. */
export type DigestSectionProvider = (userId: string, email: string) => Promise<DigestSection | null>

export type MailSampleKind = 'record' | 'history' | 'user' | 'notification' | 'none'

export interface MailSampleOption {
  id: string
  label: string
  hint?: string
}

export interface MailRendered {
  subject: string
  html: string
  /** Who production would send this to, with the reason each is on the list. */
  recipients: Array<{ email: string; reason: string }>
  category?: NotifyCategory
}

/** An email type for the admin mail harness (preview / send with real data). */
export interface MailTypeDef {
  key: string
  label: string
  group: string
  description: string
  /** Liquid template name (core or extension root) — informational for
   *  types whose builder assembles HTML itself. */
  template: string | null
  category?: NotifyCategory
  sample: {
    kind: MailSampleKind
    /** For 'record': the collection the picker browses. For 'history': the
     *  bound collection whose instances are offered (null = any). */
    collection?: string | null
    /** Extra narrowing for 'history' samples (e.g. only terminal 'canceled'). */
    history_filter?: 'canceled' | 'any'
    /** 'notification': subject prefix / category the sample rows are drawn from. */
    notification_category?: NotifyCategory
  }
  /** Sample rows the picker offers (most recent first). */
  samples: (q: string) => Promise<MailSampleOption[]>
  /** Render for a chosen sample id (+ the recipient the harness will use). */
  render: (sampleId: string, opts: { recipientUserId?: string }) => Promise<MailRendered>
}
