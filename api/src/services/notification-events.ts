import { db } from '../db/index.js'

/**
 * The in-app notification EVENT registry: every event whose wording can be
 * overridden by a `notification:<key>` template (services/notification-
 * templates.ts), with the tokens each exposes and a sampler that pulls a
 * REAL recent example out of the database so the editor's preview renders
 * what a person would actually receive, not lorem ipsum.
 *
 * Template contract: first line = subject, the rest = message (Liquid).
 */

export interface NotificationEventToken {
  name: string
  description: string
}

export interface NotificationEventDef {
  key: string
  label: string
  description: string
  category: string
  tokens: NotificationEventToken[]
  /** The wording the code uses when no override exists. */
  default_template: string
  /** A representative context (used when no real sample can be found). */
  fallback: Record<string, unknown>
  /** Pull a real recent example. Returns null when none exists. */
  sample: () => Promise<Record<string, unknown> | null>
}

async function friendlyLabel(collection: string, item: string): Promise<string> {
  try {
    const { resolveFriendlyId } = await import('./workflow-transitions.js')
    const f = await resolveFriendlyId(collection, item)
    return f ?? item
  } catch {
    return item
  }
}

async function userName(id: string | null | undefined): Promise<string> {
  if (!id) return 'Someone'
  try {
    const u = (await db('nivaro_users').where({ id }).first('first_name', 'last_name', 'email')) as
      | { first_name?: string | null; last_name?: string | null; email?: string | null }
      | undefined
    return `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim() || u?.email || 'Someone'
  } catch {
    return 'Someone'
  }
}

export const NOTIFICATION_EVENTS: NotificationEventDef[] = [
  {
    key: 'workflow_transition',
    label: 'Workflow state change',
    description:
      'Sent to workflow-state subscribers and record watchers when a record moves between states.',
    category: 'workflow',
    tokens: [
      { name: 'record', description: 'The record’s friendly id (CR26-80332)' },
      { name: 'collection', description: 'Collection name (workflows)' },
      { name: 'state', description: 'The state it moved INTO' },
      { name: 'transition', description: 'The transition label (Approve, Send back)' },
      { name: 'actor', description: 'Who moved it (empty for automatic moves)' },
      { name: 'label', description: 'The subscription’s label ("Watching CR26-80332")' }
    ],
    default_template:
      '{{ label }} {{ record }}: {{ transition }} → {{ state }}{% if actor != "" %} by {{ actor }}{% endif %}\n{% if actor != "" %}{{ actor }} moved {{ record }} to "{{ state }}" ({{ transition }}){% else %}{{ record }} moved to "{{ state }}" ({{ transition }}){% endif %}',
    fallback: {
      record: 'CR26-80332',
      collection: 'workflows',
      state: 'Waiting on Level 2 Approval',
      transition: 'Approve',
      actor: 'Robert Lee',
      label: 'workflows workflow'
    },
    sample: async () => {
      const h = (await db('nivaro_workflow_history as h')
        .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
        .leftJoin('nivaro_workflow_states as s', 's.id', 'h.to_state')
        .leftJoin('nivaro_workflow_transitions as t', 't.id', 'h.transition')
        .whereNotNull('h.transition')
        .orderBy('h.id', 'desc')
        .first(
          'i.collection',
          'i.item',
          's.label as state',
          't.label as transition',
          'h.user as actor'
        )) as
        | { collection: string; item: string; state: string; transition: string; actor: string }
        | undefined
      if (!h) return null
      return {
        record: await friendlyLabel(h.collection, String(h.item)),
        collection: h.collection,
        state: h.state ?? '',
        transition: h.transition ?? '',
        actor: await userName(h.actor),
        label: `${h.collection} workflow`
      }
    }
  },
  ...(['create', 'update', 'delete'] as const).map<NotificationEventDef>((ev) => ({
    key: `subscription.${ev}`,
    label: `Record ${ev}d (subscription / watch)`,
    description: `Sent to collection subscribers and record watchers when a record is ${ev}d.`,
    category: 'watch',
    tokens: [
      { name: 'record', description: 'The record id' },
      { name: 'collection', description: 'Collection name' },
      { name: 'actor', description: `Who ${ev}d it` },
      { name: 'event', description: `"${ev}"` },
      { name: 'label', description: 'The subscription’s label' },
      { name: 'changes', description: 'Compact "field: old → new" list (updates)' }
    ],
    default_template: `{{ label }}: {{ event }}d by {{ actor }}\n{{ actor }} {{ event }}d {{ record }} ({{ collection }}){% if changes != "" %} — {{ changes }}{% endif %}`,
    fallback: {
      record: '371393',
      collection: 'workflows',
      actor: 'Robert Lee',
      event: ev,
      label: 'Watching CR26-80329',
      changes: ev === 'update' ? 'requisition_amount: 39900 → 41200' : ''
    },
    sample: async () => {
      const a = (await db('nivaro_activity')
        .where({ action: ev })
        .whereNotNull('collection')
        .whereNot('collection', 'like', 'nivaro%')
        .orderBy('id', 'desc')
        .first('collection', 'item', 'user')) as
        | { collection: string; item: string; user: string | null }
        | undefined
      if (!a) return null
      return {
        record: await friendlyLabel(a.collection, String(a.item)),
        collection: a.collection,
        actor: await userName(a.user),
        event: ev,
        label: `Watching ${await friendlyLabel(a.collection, String(a.item))}`,
        changes: ev === 'update' ? 'amount: 400 → 520' : ''
      }
    }
  })),
  {
    key: 'comment_mention',
    label: 'Mentioned in a record note',
    description: 'Sent when someone @mentions the person in a comment on a record.',
    category: 'mentions',
    tokens: [
      { name: 'actor', description: 'Who wrote the note' },
      { name: 'record', description: 'The record id' },
      { name: 'collection', description: 'Collection name' },
      { name: 'text', description: 'The note text (first 300 characters)' }
    ],
    default_template: 'You were mentioned\n{{ text }}',
    fallback: {
      actor: 'Robert Lee',
      record: '371393',
      collection: 'workflows',
      text: '@Beth can you check the allocation on line 3?'
    },
    sample: async () => {
      const c = (await db('nivaro_comments as c')
        .join('nivaro_comment_mentions as m', 'm.comment', 'c.id')
        .orderBy('c.created_at', 'desc')
        .first('c.collection', 'c.item', 'c.user', 'c.text')) as
        | { collection: string; item: string; user: string; text: string }
        | undefined
      if (!c) return null
      return {
        actor: await userName(c.user),
        record: await friendlyLabel(c.collection, String(c.item)),
        collection: c.collection,
        text: String(c.text ?? '')
          .replace(/<[^>]+>/g, '')
          .slice(0, 300)
      }
    }
  },
  {
    key: 'chat_mention',
    label: 'Mentioned in chat',
    description: 'Sent when someone @mentions the person in a chat room.',
    category: 'mentions',
    tokens: [
      { name: 'actor', description: 'Who wrote the message' },
      { name: 'room', description: 'The room key (global, ch:ops, dm:…)' },
      { name: 'text', description: 'The message (first 300 characters)' }
    ],
    default_template: '{{ actor }} mentioned you in chat\n{{ text }}',
    fallback: {
      actor: 'Robert Lee',
      room: 'global',
      text: '@Beth the PO landed — can you close it out?'
    },
    sample: async () => {
      const m = (await db('chat_messages')
        .where('message', 'like', '%@%')
        .orderBy('id', 'desc')
        .first('room', 'sender_name', 'message')) as
        | { room: string; sender_name: string | null; message: string }
        | undefined
      if (!m) return null
      return {
        actor: m.sender_name ?? 'Someone',
        room: m.room,
        text: String(m.message).slice(0, 300)
      }
    }
  },
  {
    key: 'task_assigned',
    label: 'Task assigned',
    description: 'Sent to the assignee when a task is created for them or handed over.',
    category: 'workflow',
    tokens: [
      { name: 'title', description: 'Task title' },
      { name: 'description', description: 'Task description (may be empty)' },
      { name: 'record', description: 'The record the task is on' },
      { name: 'collection', description: 'Collection name' },
      { name: 'due', description: 'Due date (may be empty)' }
    ],
    default_template:
      'Task assigned: {{ title }}\n{% if description != "" %}{{ description }}{% else %}You have been assigned a task on {{ collection }}/{{ record }}.{% endif %}',
    fallback: {
      title: 'Attach the vendor quote',
      description: '',
      record: '371393',
      collection: 'workflows',
      due: ''
    },
    sample: async () => {
      const t = (await db('nivaro_tasks')
        .orderBy('created_at', 'desc')
        .first('title', 'description', 'collection', 'item', 'due_date')) as
        | {
            title: string
            description: string | null
            collection: string
            item: string
            due_date: string | null
          }
        | undefined
      if (!t) return null
      return {
        title: t.title,
        description: t.description ?? '',
        record: await friendlyLabel(t.collection, String(t.item)),
        collection: t.collection,
        due: t.due_date ? String(t.due_date).slice(0, 10) : ''
      }
    }
  }
]

export function findNotificationEvent(key: string): NotificationEventDef | undefined {
  return NOTIFICATION_EVENTS.find((e) => e.key === key)
}
