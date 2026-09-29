import { adminBaseUrl } from '../admin-base.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { type LinkSpec, linkTo, recordLink } from './app-links.js'
import { buildRecordCard, type RecordCard } from './mail-record-card.js'

/**
 * Builders for the emails that used to ride the plain `notification`
 * template: each returns { template, subject, data } so the SENDER (notifyUser
 * with template / template_data) and the admin mail harness render the same
 * thing from the same rows. Every builder is best-effort on the extras — a
 * missing record card never blocks the mail.
 */

export interface BuiltMail {
  template: string
  subject: string
  data: Record<string, unknown>
}

/** Date-only columns come back as UTC midnight; format them as the calendar
 *  day they name, never shifted by the process timezone. */
const dayLabel = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  })
}
const isBusiness = (c?: string | null) =>
  !!c && !c.startsWith('nivaro_') && !c.startsWith('directus_') && !c.startsWith('__')
const nameOf = (
  u?: { first_name?: string | null; last_name?: string | null; email?: string | null } | null
) => (u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null : null)

export async function cardFor(
  collection?: string | null,
  item?: string | number | null,
  recipientUserId?: string | null
): Promise<RecordCard | null> {
  if (!isBusiness(collection) || item == null || item === '') return null
  return buildRecordCard(collection as string, item, { recipientUserId }).catch(() => null)
}

async function user(id?: string | null) {
  if (!id) return null
  return (await db('nivaro_users')
    .where({ id })
    .first('first_name', 'last_name', 'email')
    .catch(() => null)) as {
    first_name: string | null
    last_name: string | null
    email: string
  } | null
}

// ── tasks ────────────────────────────────────────────────────────────────────

export async function buildTaskAssignedMail(taskId: number | string): Promise<BuiltMail | null> {
  const t = (await db('nivaro_tasks').where({ id: taskId }).first()) as
    | {
        id: number
        title: string
        description: string | null
        due_date: Date | null
        collection: string
        item: string
        created_by: string | null
        assignee: string
      }
    | undefined
  if (!t) return null
  const [card, by] = await Promise.all([cardFor(t.collection, t.item), user(t.created_by)])
  return {
    template: 'task_assigned',
    subject: `Task assigned: ${t.title}`,
    data: {
      why: nameOf(by) ? `${nameOf(by)} assigned this task to you` : 'this task was assigned to you',
      task_title: t.title,
      task_description: t.description,
      due_date: t.due_date ? new Date(t.due_date).toISOString() : null,
      due_label: dayLabel(t.due_date),
      assigned_by: nameOf(by),
      record_card: card,
      record_url: await recordLink(t.collection, t.item),
      tasks_url: await linkTo('tasks'),
      _links: {
        record_url: { kind: 'record', collection: t.collection, id: t.item },
        tasks_url: { kind: 'tasks' }
      } satisfies Record<string, LinkSpec>
    }
  }
}

export async function buildTasksDelegatedMail(
  fromUserId: string,
  taskIds: Array<number | string>
): Promise<BuiltMail> {
  const from = await user(fromUserId)
  const tasks = (await db('nivaro_tasks')
    .whereIn('id', taskIds)
    .select('id', 'title', 'due_date', 'collection', 'item')) as Array<{
    id: number
    title: string
    due_date: Date | null
    collection: string
    item: string
  }>
  return {
    template: 'tasks_delegated',
    subject: `${tasks.length} task${tasks.length === 1 ? '' : 's'} delegated to you`,
    data: {
      why: `you are ${nameOf(from) ?? 'a colleague'}'s delegate while they are out of office`,
      from_name: nameOf(from) ?? 'a colleague',
      tasks: await Promise.all(
        tasks.map(async (t) => ({
          title: t.title,
          due_date: t.due_date ? new Date(t.due_date).toISOString() : null,
          due_label: dayLabel(t.due_date),
          url: await recordLink(t.collection, t.item)
        }))
      ),
      tasks_url: await linkTo('tasks'),
      _links: { tasks_url: { kind: 'tasks' } } satisfies Record<string, LinkSpec>
    }
  }
}

// ── approvals ────────────────────────────────────────────────────────────────

export async function buildApprovalMail(
  instanceId: number | string,
  kind: 'requested' | 'rejected' | 'completed',
  opts: { stepLabel?: string | null; comment?: string | null; actorId?: string | null } = {}
): Promise<BuiltMail | null> {
  const inst = (await db('nivaro_approval_instances as i')
    .join('nivaro_approval_chains as c', 'c.id', 'i.chain')
    .where('i.id', instanceId)
    .first('i.*', 'c.name as chain_name')) as
    | {
        id: number
        collection: string
        item: string
        current_step: number
        status: string
        started_by: string
        chain_name: string
        chain: number
      }
    | undefined
  if (!inst) return null
  const [card, actor, starter, steps] = await Promise.all([
    cardFor(inst.collection, inst.item),
    user(opts.actorId),
    user(inst.started_by),
    db('nivaro_approval_chain_steps')
      .where({ chain: inst.chain })
      .orderBy('step_order')
      .select('step_order', 'label') as Promise<Array<{ step_order: number; label: string | null }>>
  ])
  const stepLabel =
    opts.stepLabel ??
    steps.find((s) => s.step_order === inst.current_step)?.label ??
    `Step ${inst.current_step + 1}`
  const subject =
    kind === 'requested'
      ? `Approval requested: ${inst.chain_name}`
      : kind === 'rejected'
        ? `Approval rejected: ${inst.chain_name}`
        : `Approval completed: ${inst.chain_name}`
  return {
    template: 'approval',
    subject,
    data: {
      why:
        kind === 'requested'
          ? `you are the approver for "${stepLabel}" of ${inst.chain_name}`
          : `you started the ${inst.chain_name} approval on this record`,
      kind,
      chain_name: inst.chain_name,
      step_label: stepLabel,
      steps: steps.map((s) => ({
        label: s.label ?? `Step ${s.step_order + 1}`,
        status:
          s.step_order < inst.current_step
            ? 'done'
            : s.step_order === inst.current_step
              ? kind === 'completed'
                ? 'done'
                : 'current'
              : 'upcoming'
      })),
      comment: opts.comment ?? null,
      actor_name: nameOf(actor),
      requested_by: nameOf(starter),
      record_card: card,
      record_url: await recordLink(inst.collection, inst.item),
      approvals_url: await linkTo('approvals'),
      _links: {
        record_url: { kind: 'record', collection: inst.collection, id: inst.item },
        approvals_url: { kind: 'approvals' }
      } satisfies Record<string, LinkSpec>
    }
  }
}

// ── SLA escalation ───────────────────────────────────────────────────────────

export async function buildSlaEscalationMail(args: {
  ruleName: string
  stateKey: string
  templateId?: string | null
  tier: number
  hoursPast: number
  friendly: string
  collection: string
  item: string
  /** The ladder tier's target — 'owner' | 'manager' | 'user:<id>'. */
  notify?: string | null
}): Promise<BuiltMail> {
  const [card, state] = await Promise.all([
    cardFor(args.collection, args.item),
    args.templateId
      ? (db('nivaro_workflow_states')
          .where({ template: args.templateId, key: args.stateKey })
          .first('label')
          .catch(() => null) as Promise<{ label: string } | null>)
      : Promise.resolve(null)
  ])
  const days = Math.round((args.hoursPast / 24) * 10) / 10
  return {
    template: 'sla_escalation',
    subject: `SLA escalation (tier ${args.tier + 1}): ${args.ruleName}`,
    data: {
      why:
        args.notify === 'manager'
          ? `you manage an owner of this record and the SLA rule "${args.ruleName}" escalates to managers at tier ${args.tier + 1}`
          : args.notify?.startsWith('user:')
            ? `the SLA rule "${args.ruleName}" escalates to you at tier ${args.tier + 1}`
            : `you own this record in ${state?.label ?? args.stateKey.replace(/_/g, ' ')} and its SLA is past due`,
      rule_name: args.ruleName,
      tier: args.tier + 1,
      state_label: state?.label ?? args.stateKey.replace(/_/g, ' '),
      hours_past: Math.round(args.hoursPast),
      days_past: days,
      friendly_id: args.friendly,
      record_card: card,
      record_url: await recordLink(args.collection, args.item),
      _links: {
        record_url: { kind: 'record', collection: args.collection, id: args.item }
      } satisfies Record<string, LinkSpec>
    }
  }
}

// ── alerts (per-record definition / metric rule / report alert) ──────────────

export async function buildRecordAlertMail(
  def: { name: string; collection: string; field: string; operator: string; threshold: unknown },
  item: string,
  fieldValue: string,
  detail?: string
): Promise<BuiltMail> {
  const [card, fieldRow] = await Promise.all([
    cardFor(def.collection, item),
    db('nivaro_fields')
      .where({ collection: def.collection, field: def.field })
      .first('label')
      .catch(() => null) as Promise<{ label: string | null } | null>
  ])
  return {
    template: 'alert',
    subject: `Alert: ${def.name}`,
    data: {
      why: `you subscribed to the alert "${def.name}"`,
      kind: 'record',
      rule_name: def.name,
      metric_name: fieldRow?.label || def.field.replace(/_/g, ' '),
      metric_value: fieldValue,
      operator: def.operator,
      threshold_value: def.threshold == null ? '' : String(def.threshold),
      detail: detail ?? null,
      record_card: card,
      record_url: await recordLink(def.collection, item),
      manage_url: await linkTo('alerts'),
      _links: {
        record_url: { kind: 'record', collection: def.collection, id: item },
        manage_url: { kind: 'alerts' }
      } satisfies Record<string, LinkSpec>
    }
  }
}

export async function buildReportAlertMail(args: {
  alertName: string
  widgetTitle: string
  conditions: Array<{ field: string; op: string; value: unknown; now: unknown }>
  reportId: string
  reportName?: string | null
}): Promise<BuiltMail> {
  const reportUrl = await linkTo('report', { id: args.reportId })
  return {
    template: 'alert',
    subject: `Report alert: ${args.alertName}`,
    data: {
      why: `you set up the alert "${args.alertName}"${args.reportName ? ` on the report "${args.reportName}"` : ''}`,
      kind: 'report',
      rule_name: args.alertName,
      widget_title: args.widgetTitle,
      report_name: args.reportName ?? null,
      conditions: args.conditions.map((c) => ({
        label: `${c.field} ${c.op} ${c.value}`,
        now: String(c.now ?? 0)
      })),
      report_url: reportUrl,
      manage_url: reportUrl,
      _links: {
        report_url: { kind: 'report', id: args.reportId },
        manage_url: { kind: 'report', id: args.reportId }
      } satisfies Record<string, LinkSpec>
    }
  }
}

// ── access requests ──────────────────────────────────────────────────────────

export async function buildAccessRequestMail(args: {
  requesterId?: string | null
  requesterName: string
  collection: string
  item?: string | null
  friendly?: string | null
  note?: string | null
  reasons?: Array<{ message?: string }> | null
}): Promise<BuiltMail> {
  const [card, requester] = await Promise.all([
    cardFor(args.collection, args.item ?? null),
    user(args.requesterId)
  ])
  const target = args.item
    ? `${args.collection.replace(/_/g, ' ')} ${args.friendly ?? args.item}`
    : args.collection.replace(/_/g, ' ')
  return {
    template: 'access_request',
    subject: `${args.requesterName} requested access to ${args.item ? `${args.collection}/${args.friendly ?? args.item}` : args.collection}`,
    data: {
      why: 'you are an administrator — access requests go to every admin',
      requester_name: args.requesterName,
      requester_email: requester?.email ?? null,
      target_label: target,
      note: args.note ?? null,
      reasons: (args.reasons ?? []).map((r) => r.message).filter(Boolean),
      record_card: card,
      manage_url: await linkTo('access_requests', {}, { app: 'admin' })
    }
  }
}

export async function buildAccessDecisionMail(args: {
  decision: 'granted' | 'declined' | 'expired'
  collection: string
  item?: string | null
  friendly?: string | null
  applied?: string[]
  days?: number
}): Promise<BuiltMail> {
  const card = await cardFor(args.collection, args.item ?? null)
  const target = args.item
    ? `${args.collection.replace(/_/g, ' ')} ${args.friendly ?? args.item}`
    : args.collection.replace(/_/g, ' ')
  const subject =
    args.decision === 'granted'
      ? `Access granted: ${target}`
      : args.decision === 'declined'
        ? `Access request declined: ${target}`
        : `Access request expired: ${target}`
  return {
    template: 'access_decision',
    subject,
    data: {
      why: `you asked for access to ${target}`,
      decision: args.decision,
      target_label: target,
      applied: args.applied ?? [],
      days: args.days ?? null,
      record_card: card,
      record_url: args.item ? await recordLink(args.collection, args.item) : await linkTo('home'),
      _links: args.item
        ? ({
            record_url: { kind: 'record', collection: args.collection, id: args.item }
          } satisfies Record<string, LinkSpec>)
        : {}
    }
  }
}

// ── chat mentions ────────────────────────────────────────────────────────────

export async function roomLabel(room: string): Promise<string> {
  if (room === 'global') return 'General'
  if (room.startsWith('dm:')) return 'a direct message'
  if (room.startsWith('ch:')) {
    const ch = (await db('nivaro_chat_channels')
      .where({ key: room.slice(3) })
      .first('name')
      .catch(() => null)) as { name: string } | null
    return ch?.name ? `#${ch.name}` : `#${room.slice(3)}`
  }
  return room
}

export async function buildMentionMail(args: {
  senderId?: string | null
  senderName?: string | null
  room: string
  message: string
  channelWide?: boolean
}): Promise<BuiltMail> {
  const [label, sender] = await Promise.all([roomLabel(args.room), user(args.senderId)])
  const senderName = args.senderName ?? nameOf(sender) ?? 'Someone'
  const excerpt = args.message.replace(/@\[([^\]]+)\]/g, '@$1').slice(0, 600)
  return {
    template: 'mention',
    subject: args.channelWide
      ? `@channel in ${args.room.slice(3)}`
      : `${senderName} mentioned you in chat`,
    data: {
      why: args.channelWide
        ? `${senderName} messaged everyone in ${label}`
        : `${senderName} mentioned you in ${label}`,
      sender_name: senderName,
      sender_email: sender?.email ?? null,
      room_label: label,
      channel_wide: !!args.channelWide,
      excerpt,
      chat_url: await linkTo('chat', { room: args.room }),
      _links: { chat_url: { kind: 'chat', room: args.room } } satisfies Record<string, LinkSpec>
    }
  }
}

// ── queue entry ──────────────────────────────────────────────────────────────

export async function buildQueueEntryMail(args: {
  queueId: string
  queueName: string
  label?: string | null
  items: Array<{ label: string; collection: string; item_id: string | number }>
  countOnly?: number
}): Promise<BuiltMail> {
  const n = args.countOnly ?? args.items.length
  return {
    template: 'queue_entry',
    subject: `${args.queueName}: ${n} new item${n === 1 ? '' : 's'}`,
    data: {
      why: `you subscribed to the queue "${args.label ?? args.queueName}"`,
      queue_name: args.label ?? args.queueName,
      count: n,
      items: await Promise.all(
        args.items.slice(0, 15).map(async (i) => ({
          label: i.label,
          url: await recordLink(i.collection, i.item_id)
        }))
      ),
      queue_url: await linkTo('queue', { id: args.queueId }),
      _links: { queue_url: { kind: 'queue', id: args.queueId } } satisfies Record<string, LinkSpec>
    }
  }
}

// ── line SLA ─────────────────────────────────────────────────────────────────

export async function buildLineSlaMail(f: {
  parentCollection: string
  parentId: string
  friendlyId: string
  count: number
  label: string
  days: number
  subject: string
}): Promise<BuiltMail> {
  const card = await cardFor(f.parentCollection, f.parentId)
  return {
    template: 'line_sla',
    subject: f.subject,
    data: {
      why: `you currently own ${f.friendlyId} and its lines are missing ${f.label}`,
      friendly_id: f.friendlyId,
      count: f.count,
      field_label: f.label,
      days: f.days,
      record_card: card,
      record_url: await recordLink(f.parentCollection, f.parentId),
      _links: {
        record_url: { kind: 'record', collection: f.parentCollection, id: f.parentId }
      } satisfies Record<string, LinkSpec>
    }
  }
}

// ── Structured notices (template `notice`) ──────────────────────────────────
// System, monitoring and report emails that have FACTS to show rather than a
// record to open. Each builder reads its own row, so the sender and the mail
// harness render the same thing.

type Fact = { label: string; value: string | null; tone?: 'danger' | 'warn' | 'ok' }

const when = (d: Date | string | null | undefined): string | null => {
  if (!d) return null
  const dt = new Date(d)
  if (Number.isNaN(dt.getTime())) return null
  return dt.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short'
  })
}

const seconds = (s: number | null | undefined): string | null => {
  if (s == null || !Number.isFinite(Number(s))) return null
  const n = Math.round(Number(s))
  if (n < 60) return `${n}s`
  const m = Math.floor(n / 60)
  return m < 60 ? `${m}m ${n % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const bytes = (b: number | string | null | undefined): string | null => {
  const n = Number(b)
  if (!Number.isFinite(n) || n <= 0) return null
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const titleWords = (s: string) =>
  s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

/** A browser + OS description from a user-agent string; null when it says nothing useful. */
export function describeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : null
  if (browser && os) return `${browser} on ${os}`
  return browser ?? os ?? ua.slice(0, 80)
}

const SIGN_IN_METHODS: Record<string, string> = {
  oidc: 'Microsoft single sign-on',
  saml: 'SAML single sign-on',
  password: 'Password',
  static_token: 'Access token',
  totp: 'Password + authenticator code'
}

export async function buildSignInMail(
  eventId: number | string,
  recipientUserId?: string | null
): Promise<BuiltMail | null> {
  const e = (await db('nivaro_login_events').where({ id: eventId }).first()) as
    | {
        id: number
        user: string
        method: string | null
        ip: string | null
        user_agent: string | null
        created_at: Date
      }
    | undefined
  if (!e) return null
  const facts: Fact[] = [
    { label: 'When', value: when(e.created_at) },
    {
      label: 'From',
      value: e.ip ? `${e.ip} (not seen on your account in 90 days)` : 'Unknown address'
    },
    { label: 'Device', value: describeUserAgent(e.user_agent) },
    {
      label: 'Signed in with',
      value: e.method ? (SIGN_IN_METHODS[e.method] ?? titleWords(e.method)) : null
    }
  ]
  return {
    template: 'notice',
    subject: 'New sign-in to your account',
    data: {
      eyebrow: 'Security',
      eyebrow_tone: 'warn',
      heading: 'New sign-in to your account',
      lead: 'Someone just signed in to your account from an address it has not used before.',
      facts,
      action_url: await linkTo('profile', {}, { recipientUserId: recipientUserId ?? e.user }),
      action_label: 'Review your sessions',
      footnote:
        'If this was you, there is nothing to do. If it was not, sign out your other sessions from your profile and tell an administrator.',
      why: 'this is a security notice about your own account'
    }
  }
}

export async function buildFlowFailedMail(
  flowId: string,
  opts: { error?: string | null; runId?: number | string | null } = {}
): Promise<BuiltMail | null> {
  const flow = (await db('nivaro_flows').where({ id: flowId }).first()) as
    | { id: string; name: string; trigger: string | null; status: string | null }
    | undefined
  if (!flow) return null
  const run = (await (opts.runId != null
    ? db('nivaro_flow_runs').where({ id: opts.runId }).first()
    : db('nivaro_flow_runs').where({ flow: flowId }).orderBy('id', 'desc').first())) as
    | {
        id: number
        trigger: string | null
        status: string
        started_at: Date | null
        duration_ms: number | null
        error_message: string | null
        halted_at: string | null
      }
    | undefined
  const error = opts.error ?? run?.error_message ?? null
  const base = adminBaseUrl() ?? config.PUBLIC_URL
  return {
    template: 'notice',
    subject: `Flow "${flow.name}" failed`,
    data: {
      eyebrow: 'Automation',
      eyebrow_tone: 'danger',
      heading: `Flow "${flow.name}" failed`,
      lead: 'A run of this flow stopped with an error. Runs after it are not held back, but whatever this run was meant to do did not happen.',
      facts: [
        { label: 'Flow', value: flow.name },
        { label: 'Triggered by', value: run?.trigger ?? flow.trigger ?? null },
        { label: 'Started', value: when(run?.started_at) },
        {
          label: 'Ran for',
          value: run?.duration_ms != null ? seconds(run.duration_ms / 1000) : null
        },
        { label: 'Stopped at step', value: run?.halted_at ?? null, tone: 'danger' }
      ] satisfies Fact[],
      quote: error,
      quote_label: error ? 'Error' : null,
      action_url: `${base}/flows/${flow.id}`,
      action_label: 'Open the flow',
      footnote: 'You get this at most once an hour per flow while it keeps failing.',
      why: 'you created this flow'
    }
  }
}

export async function buildImportRunMail(
  queueId: number | string,
  recipientUserId?: string | null
): Promise<BuiltMail | null> {
  const q = (await db('nivaro_import_queue as q')
    .leftJoin('nivaro_import_definitions as d', 'd.id', 'q.definition')
    .leftJoin('nivaro_files as f', 'f.id', 'q.file')
    .where('q.id', queueId)
    .first(
      'q.id',
      'q.import_key',
      'q.status',
      'q.row_count',
      'q.duration',
      'q.logs',
      'q.started_at',
      'q.finished_at',
      'q.created_by',
      'd.label as definition_label',
      'f.filename_download as file_name'
    )) as
    | {
        id: number
        import_key: string
        status: string
        row_count: number | null
        duration: number | null
        logs: string | null
        started_at: Date | null
        finished_at: Date | null
        created_by: string | null
        definition_label: string | null
        file_name: string | null
      }
    | undefined
  if (!q) return null
  const name = q.definition_label || titleWords(q.import_key)
  const failed = q.status === 'error'
  const logLines = (q.logs ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const url = await linkTo('imports', {}, { recipientUserId: recipientUserId ?? q.created_by })
  return {
    template: 'notice',
    subject: `${name} import ${failed ? 'failed' : 'completed'}`,
    data: {
      eyebrow: 'Import',
      eyebrow_tone: failed ? 'danger' : 'ok',
      heading: `${name} import ${failed ? 'failed' : 'completed'}`,
      lead: failed
        ? 'The file you queued did not finish importing. Nothing after the failing step was applied.'
        : logLines[0] && !/^\s*\d/.test(logLines[0])
          ? logLines[0]
          : 'The file you queued finished importing.',
      facts: [
        { label: 'File', value: q.file_name },
        { label: 'Status', value: failed ? 'Failed' : 'Completed', tone: failed ? 'danger' : 'ok' },
        {
          label: 'Rows in the file',
          value: q.row_count != null ? q.row_count.toLocaleString('en-US') : null
        },
        { label: 'Finished', value: when(q.finished_at) },
        { label: 'Took', value: seconds(q.duration) },
        { label: 'Run', value: `#${q.id}` }
      ] satisfies Fact[],
      quote: failed
        ? logLines.slice(0, 6).join(' · ').slice(0, 600)
        : logLines.slice(1, 5).join(' · ').slice(0, 600),
      quote_label: failed ? 'What went wrong' : logLines.length > 1 ? 'Summary' : null,
      action_url: `${url}${url.includes('?') ? '&' : '?'}run=${q.id}`,
      action_label: 'Open the run',
      why: 'you queued this import'
    }
  }
}

export async function buildExportReadyMail(fileId: string): Promise<BuiltMail | null> {
  const f = (await db('nivaro_files').where({ id: fileId }).first()) as
    | {
        id: string
        filename_download: string | null
        title: string | null
        type: string | null
        filesize: number | string | null
        uploaded_on: Date | null
        expires_at: Date | null
      }
    | undefined
  if (!f) return null
  const name = f.filename_download || f.title || 'export'
  return {
    template: 'notice',
    subject: `Export ready: ${name}`,
    data: {
      eyebrow: 'Export',
      eyebrow_tone: 'ok',
      heading: 'Your export is ready',
      lead: 'The export you started has finished and is saved to Files.',
      facts: [
        { label: 'File', value: name },
        { label: 'Size', value: bytes(f.filesize) },
        { label: 'Created', value: when(f.uploaded_on) },
        { label: 'Available until', value: when(f.expires_at) }
      ] satisfies Fact[],
      action_url: `${config.PUBLIC_URL.replace(/\/$/, '')}/api/files/${f.id}?download=1`,
      action_label: 'Download',
      footnote: 'The download link needs you to be signed in.',
      why: 'you started this export'
    }
  }
}

export async function buildAnomalyMail(
  logId: number | string,
  recipientUserId?: string | null
): Promise<BuiltMail | null> {
  const row = (await db('nivaro_anomaly_log as l')
    .join('nivaro_anomaly_rules as r', 'r.id', 'l.rule_id')
    .leftJoin('nivaro_anomaly_definitions as d', 'd.id', 'r.definition_id')
    .where('l.id', logId)
    .first(
      'l.id',
      'l.detected_at',
      'l.subject_id',
      'l.stats_snapshot',
      'l.ai_explanation',
      'l.status',
      'r.name as rule_name',
      'r.sensitivity',
      'r.created_by',
      'd.name as def_name',
      'd.key as def_key'
    )) as
    | {
        id: number
        detected_at: Date | null
        subject_id: string
        stats_snapshot: string | null
        ai_explanation: string | null
        status: string
        rule_name: string
        sensitivity: string | null
        created_by: string | null
        def_name: string | null
        def_key: string | null
      }
    | undefined
  if (!row) return null
  let s: Record<string, unknown> = {}
  try {
    s = JSON.parse(row.stats_snapshot ?? '{}') as Record<string, unknown>
  } catch {
    s = {}
  }
  const num = (v: unknown, digits = 0) =>
    v == null || v === '' || !Number.isFinite(Number(v))
      ? null
      : Number(v).toLocaleString('en-US', { maximumFractionDigits: digits })
  const group = s.group && typeof s.group === 'object' ? (s.group as Record<string, unknown>) : {}
  const facts: Fact[] = [
    { label: 'What', value: String(s.subject_label ?? row.subject_id) },
    ...Object.entries(group)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => ({ label: titleWords(k), value: String(v) })),
    { label: 'Detected', value: when(row.detected_at) },
    { label: 'Value', value: num(s.value ?? s.amount, 2), tone: 'warn' },
    { label: 'Typical', value: num(s.mean ?? s.expected, 2) },
    { label: 'Deviation', value: s.z_score != null ? `${num(s.z_score, 1)}σ` : null },
    { label: 'This period', value: num(s.current_count) },
    { label: 'Same period before', value: num(s.prior_count) },
    {
      label: 'Change',
      value: s.pct_increase != null ? `+${num(s.pct_increase)}%` : null,
      tone: 'warn'
    },
    { label: 'Similar entries', value: num(s.match_count) },
    { label: 'Within', value: s.window_days != null ? `${num(s.window_days)} days` : null },
    {
      label: 'Amounts',
      value:
        s.min_amount != null && s.max_amount != null
          ? `${num(s.min_amount, 2)} to ${num(s.max_amount, 2)}`
          : null
    },
    { label: 'Sensitivity', value: row.sensitivity ? titleWords(row.sensitivity) : null }
  ]
  // The model writes Markdown; mail shows it as plain sentences.
  const explanation = (row.ai_explanation ?? '')
    .replace(/^#+\s.*$/gm, '') // a Markdown heading repeats the subject — drop it
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
  return {
    template: 'notice',
    subject: `Anomaly detected: ${row.rule_name}`,
    data: {
      eyebrow: row.def_name ?? 'Anomaly',
      eyebrow_tone: 'warn',
      heading: `${String(s.subject_label ?? row.subject_id)} looks unusual`,
      lead: `Your rule "${row.rule_name}" flagged this during its last check.`,
      facts,
      quote: explanation.slice(0, 900) || null,
      quote_label: explanation ? 'Why it stands out' : null,
      action_url: await linkTo(
        'alerts',
        {},
        { recipientUserId: recipientUserId ?? row.created_by }
      ),
      action_label: 'Review in Alerts',
      footnote:
        'Acknowledge or resolve it there; the same thing is not flagged again while it is open.',
      why: 'you own this anomaly rule'
    }
  }
}
