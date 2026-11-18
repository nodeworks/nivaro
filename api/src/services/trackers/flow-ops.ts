import type { FlowData, FlowExecutionContext } from '@nivaro/extension-kit'
import type { FastifyInstance } from 'fastify'
import type { User } from '../../types.js'
import { trackersEnabled } from './feature.js'
import { ISSUE_CHANGED_TRIGGER, setFlowEventLogger } from './flow-events.js'
import type { RuleAction } from './rules.js'
import type { SourceKind } from './sources/types.js'
import {
  defaultBodyTemplate,
  defaultRecordBodyTemplate,
  defaultRecordTitleTemplate,
  defaultTicketBodyTemplate,
  defaultTicketTitleTemplate,
  defaultTitleTemplate
} from './templates.js'

/**
 * GitLab in Flows (self-hosted only, registered at boot beside the tracker crons):
 *  - operation `gitlab.create_issue` opens a GitLab issue for the flow's record — an issue-log
 *    entry (`nivaro_issues`), a support ticket (`nivaro_tasks`) or any business record — through
 *    the same outbox as everything else. Record fields are read as the flow's person (the user who
 *    set the flow off, else the flow's author): a field they cannot read never reaches GitLab.
 *  - trigger `gitlab.issue_changed` fires when GitLab changes a linked issue (state, labels, a
 *    comment), once per Nivaro member, ids only (flow-events.ts).
 * With the master switch off the operation does nothing and says so ({skipped:'FEATURE_OFF'}).
 */

export const CREATE_ISSUE_OP = 'gitlab.create_issue'

type Row = Record<string, unknown>

export interface FlowCreateInput {
  connection: unknown
  project_id?: unknown
  collection: string
  item: string
  title_template?: unknown
  body_template?: unknown
  labels?: unknown
}

/** Who runs the step: the person who set the flow off, and the flow (for its author). */
export interface FlowCaller {
  userId?: string
  flowId?: string
  /** A flow test run: everything is checked and rendered, nothing is queued. */
  dryRun?: boolean
}

export type FlowCreateResult =
  | { skipped: 'FEATURE_OFF' | 'ALREADY_LINKED' | 'SOURCE_OFF' }
  | { skipped: 'CAP'; detail: string }
  | { preview: { connection: number; project: number; title: string; labels: string[] } }
  | { outbox_id: number; kind: SourceKind; source_id: string }
  | { error: string; code: string }

/** Which source a flow's record is: the issue log, a support ticket, or a business record. */
export function flowSource(collection: string, item: string): { kind: SourceKind; id: string } {
  if (collection === 'nivaro_issues') return { kind: 'issue', id: item }
  if (collection === 'nivaro_tasks') return { kind: 'ticket', id: item }
  return { kind: 'record', id: `${collection}:${item}` }
}

const posInt = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

function labelList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (typeof v === 'string')
    return v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  return []
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : '')

/** The step's action: its templates (else the kind's defaults) and labels. */
function stepAction(kind: SourceKind, input: FlowCreateInput, connection: number): RuleAction {
  const title =
    text(input.title_template) ||
    (kind === 'issue'
      ? defaultTitleTemplate()
      : kind === 'ticket'
        ? defaultTicketTitleTemplate()
        : defaultRecordTitleTemplate())
  const body =
    text(input.body_template) ||
    (kind === 'issue'
      ? defaultBodyTemplate()
      : kind === 'ticket'
        ? defaultTicketBodyTemplate()
        : defaultRecordBodyTemplate())
  const project = posInt(input.project_id)
  return {
    connection,
    ...(project ? { project_id: project } : {}),
    issue_type: 'issue',
    labels: labelList(input.labels),
    assignee_ids: [],
    map_assignee_by_email: false,
    confidential: false,
    title_template: title,
    body_template: body,
    attach_screenshot: false,
    attach_replay_link: false,
    include_details: true
  }
}

/** The person whose read the record goes out as: the flow's user, else its author. */
async function flowReader(ctx: FlowCaller): Promise<User | null> {
  let id = ctx.userId ?? null
  if (!id && ctx.flowId) {
    const { resolveFlowCreator } = await import('../flow-executor.js')
    id = await resolveFlowCreator(ctx.flowId).catch(() => null)
  }
  if (!id) return null
  const { getUser } = await import('../users.js')
  const user = await getUser(id).catch(() => undefined)
  return user && user.status === 'active' ? user : null
}

/**
 * The step itself (exported for tests): queue a GitLab create for the flow's record. Never
 * throws — a refusal comes back as {error, code}.
 */
export async function createIssueFromFlow(
  input: FlowCreateInput,
  ctx: FlowCaller
): Promise<FlowCreateResult> {
  if (!(await trackersEnabled())) return { skipped: 'FEATURE_OFF' }
  const connection = posInt(input.connection)
  if (!connection) return { error: 'Choose a GitLab connection', code: 'INVALID_OPTIONS' }
  const collection = String(input.collection ?? '').trim()
  const item = String(input.item ?? '').trim()
  if (!collection || !item)
    return { error: 'gitlab.create_issue needs a record (collection and id)', code: 'NO_RECORD' }
  const src = flowSource(collection, item)
  const { normalizeSourceId } = await import('./sources/types.js')
  const sourceId = normalizeSourceId(src.kind, src.id)
  if (!sourceId) return { error: 'That is not a record GitLab can link', code: 'BAD_RECORD' }
  // The person the step acts as: the one who set the flow off, else the flow's author — with
  // that person's own access (issues: administrators; tickets: people who can see it; records:
  // read as them).
  const reader = await flowReader(ctx)
  if (!reader)
    return {
      error: 'No active person to act as (the flow has no user or author)',
      code: 'NO_READER'
    }
  const { isAdminRole } = await import('../user-scopes.js')
  const admin = await isAdminRole(reader.role)
  if (src.kind === 'issue' && !admin)
    return {
      error: 'Only an administrator can send issue-log entries to GitLab',
      code: 'FORBIDDEN'
    }
  if (src.kind === 'ticket') {
    const { sourceFor } = await import('./sources/index.js')
    if (!(await sourceFor('ticket').canRead(reader, sourceId, admin)))
      return { error: 'The flow’s person cannot see this support request', code: 'FORBIDDEN' }
  }
  const { LinkError, previewSourceCreate, requestSourceCreate } = await import('./links.js')
  const opts = {
    connection,
    project_id: posInt(input.project_id),
    action: stepAction(src.kind, input, connection),
    asUser: reader
  }
  const refusal = (err: unknown): FlowCreateResult => {
    if (err instanceof LinkError) {
      if (err.code === 'ALREADY_LINKED') return { skipped: 'ALREADY_LINKED' }
      if (err.code === 'SOURCE_OFF') return { skipped: 'SOURCE_OFF' }
      return { error: err.message, code: err.code }
    }
    return { error: err instanceof Error ? err.message : 'Could not queue it', code: 'FAILED' }
  }
  if (ctx.dryRun) {
    try {
      const p = await previewSourceCreate(src.kind, sourceId, opts)
      return {
        preview: {
          connection: p.connection,
          project: p.project_id,
          title: p.title,
          labels: p.labels
        }
      }
    } catch (err) {
      return refusal(err)
    }
  }
  // Flow-created GitLab issues count toward the connection's hourly cap (decision rule -1).
  const engine = await import('./engine.js')
  let claim: Awaited<ReturnType<typeof engine.claimFlowFire>>
  try {
    claim = await engine.claimFlowFire(connection, src.kind === 'record' ? 0 : Number(sourceId))
  } catch (err) {
    return {
      error: `Could not claim a slot to open a GitLab issue: ${err instanceof Error ? err.message : String(err)}`,
      code: 'CLAIM_FAILED'
    }
  }
  if (!claim.ok) return { skipped: 'CAP', detail: claim.detail }
  try {
    const { outboxId } = await requestSourceCreate(src.kind, sourceId, {
      ...opts,
      via: 'rule',
      userId: ctx.userId
    })
    await engine
      .settleClaim(claim.id, `Flow: queued a new GitLab issue for ${src.kind} ${sourceId}`)
      .catch(() => {})
    return { outbox_id: outboxId, kind: src.kind, source_id: sourceId }
  } catch (err) {
    const out = refusal(err)
    await engine
      .releaseClaim(
        claim.id,
        'skipped' in out ? 'linked' : 'error',
        `Flow: ${'error' in out ? out.error : 'skipped' in out ? out.skipped : ''} (${src.kind} ${sourceId})`
      )
      .catch(() => {})
    return out
  }
}

let registered = false

/** Boot (self-hosted only): the operation + trigger, and start emitting gitlab.issue_changed. */
export async function registerTrackerFlows(app: FastifyInstance): Promise<void> {
  if (process.env.CLOUD_META_DB_URL) return
  setFlowEventLogger(app.log)
  if (registered) return
  registered = true
  const { registerOp, registerTrigger } = await import('../../flows/registry.js')
  const { resolveTemplate } = await import('../flow-template-render.js')

  registerTrigger({
    type: ISSUE_CHANGED_TRIGGER,
    label: 'GitLab issue changed',
    description:
      'Fires when a linked GitLab issue changes (GitLab sync must be on): closed or reopened, ' +
      'labels changed, or a comment added. One event per linked Nivaro item. Payload (ids only): ' +
      'connection, link, kind (issue | ticket | record), source_id, collection, item, project_id, ' +
      'iid, change (state | labels | comment), state (opened | closed, for state), note_id (for ' +
      'comment). Filter with a Condition operation (e.g. change eq state, collection eq orders).',
    fields: []
  })

  registerOp({
    type: CREATE_ISSUE_OP,
    label: 'Create GitLab issue',
    color: '#fc6d26',
    description:
      "Opens a GitLab issue for the flow's record (any record, a support request or an issue-log " +
      'entry) through GitLab sync. Fields are read as the person who set the flow off (else the ' +
      "flow's author) — a field they cannot read never goes to GitLab. Already linked = skipped. " +
      'Does nothing while GitLab sync is off.',
    fields: [
      {
        key: 'connection',
        label: 'GitLab connection id',
        type: 'number',
        required: true,
        description: 'The id shown on Connections → Issue trackers.'
      },
      {
        key: 'project_id',
        label: 'GitLab project id',
        type: 'number',
        description: "Empty = the connection's default project."
      },
      {
        key: 'collection',
        label: 'Collection',
        type: 'string',
        placeholder: '{{collection}}',
        defaultValue: '{{collection}}'
      },
      {
        key: 'item',
        label: 'Record id',
        type: 'string',
        placeholder: '{{item}}',
        defaultValue: '{{item}}'
      },
      {
        key: 'title_template',
        label: 'Title template',
        type: 'string',
        description: 'Liquid, e.g. {{ label }} for a record. Empty = the default.'
      },
      {
        key: 'body_template',
        label: 'Description template',
        type: 'textarea',
        description: 'Liquid. Empty = the default for the kind of record.'
      },
      {
        key: 'labels',
        label: 'Labels',
        type: 'string',
        description: 'Comma-separated GitLab labels (added to the connection labels).'
      }
    ],
    handler: async (opts: Row, data: FlowData, ctx: FlowExecutionContext) => {
      const result = await createIssueFromFlow(
        {
          connection: opts.connection,
          project_id: opts.project_id,
          collection: resolveTemplate(String(opts.collection ?? '{{collection}}'), data),
          item: resolveTemplate(String(opts.item ?? '{{item}}'), data),
          title_template: opts.title_template,
          body_template: opts.body_template,
          labels: opts.labels
        },
        ctx
      )
      if ('error' in result)
        return { status: 'reject', output: { ...data, $error: `gitlab: ${result.error}` } }
      if ('preview' in result)
        return { status: 'resolve', output: { ...data, $preview_gitlab: result.preview } }
      return { status: 'resolve', output: { ...data, $gitlab: result } }
    }
  })
}
