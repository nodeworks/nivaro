import { createHash, randomUUID } from 'node:crypto'
import { openSecret } from '../../secrets.js'
import { scrubValues } from '../context.js'
import { mkOp, str } from '../entra/shared.js'
import { typedName } from '../plan-words.js'
import { hostAllowed, ProviderFetchError } from '../provider-fetch.js'
import type { HubResourceRow } from '../store.js'
import type {
  DesiredResource,
  HealthAnswer,
  Observed,
  OpResult,
  OutboundMessage,
  PlannedOp,
  ProviderContext
} from '../types.js'
import { isRetryableStatus, ProviderError } from '../types.js'
import { botReady, conversationIdProblem, sendToConversation, serviceUrlProblem } from './bot.js'
import { TARGET, TEAMS_TYPES } from './specs.js'

/**
 * Teams notify targets: where Hub events go inside Teams. Microsoft Graph with app-only access
 * cannot post into a channel, so a target is one of two things the Hub holds itself (nothing
 * exists at Microsoft to create):
 *   webhook — a Teams Workflows webhook URL (sealed); the message is an adaptive card POSTed to it.
 *   bot     — the Nivaro Teams bot's proactive message into a conversation it is installed in.
 * The provider id is `<mode>:<uuid>:<hash>`: the hash covers the bot's conversation + address, so
 * a change to them reads as a plan diff without any provider read. The webhook address carries a
 * signature in its query: it is scrubbed from every error and never answered.
 */

const label = TEAMS_TYPES.find((t) => t.key === TARGET)?.label ?? TARGET

/** Hosts a Workflows (or legacy connector) webhook address may be on. */
export const WEBHOOK_HOSTS: readonly string[] = [
  '*.logic.azure.com',
  '*.api.powerplatform.com',
  '*.webhook.office.com'
]
const WEBHOOK_PATHS = ['/workflows/', '/powerautomate/', '/webhookb2/']

export type TargetMode = 'webhook' | 'bot'

const modeOf = (v: unknown): TargetMode => (v === 'bot' ? 'bot' : 'webhook')

const botHash = (desired: { fields: Record<string, unknown> }): string =>
  createHash('sha256')
    .update(
      `${String(desired.fields.conversation_id ?? '').trim()}|${String(desired.fields.service_url ?? '').trim()}`
    )
    .digest('hex')
    .slice(0, 12)

const hashOf = (mode: TargetMode, desired: { fields: Record<string, unknown> }): string =>
  mode === 'bot' ? botHash(desired) : 'w'

export function parseTargetId(
  externalId: string
): { mode: TargetMode; uuid: string; hash: string } | null {
  const m = /^(webhook|bot):([0-9a-f-]{36}):([0-9a-f]{1,12}|w)$/.exec(externalId ?? '')
  return m ? { mode: m[1] as TargetMode, uuid: m[2] as string, hash: m[3] as string } : null
}

/** Why `raw` is not an acceptable Workflows webhook address (empty = fine). */
export function webhookUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'Enter the Workflows webhook URL.'
  if (raw.length > 4096) return 'The webhook URL is too long.'
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return 'That is not a valid webhook URL.'
  }
  if (u.protocol !== 'https:') return 'A webhook URL must start with https://.'
  if (u.username || u.password) return 'A webhook URL may not carry a login.'
  if (!hostAllowed(u.hostname, WEBHOOK_HOSTS))
    return 'That is not a Teams Workflows webhook address (it should be on logic.azure.com, api.powerplatform.com or webhook.office.com).'
  if (!WEBHOOK_PATHS.some((p) => u.pathname.startsWith(p)))
    return 'That address is not a Teams webhook (its path should start with /workflows/, /powerautomate/ or /webhookb2/).'
  return null
}

export function observedTarget(externalId: string): Observed | null {
  const id = parseTargetId(externalId)
  if (!id) return null
  // Nothing is read from Microsoft: only what the provider id itself says.
  return {
    type: TARGET,
    externalId,
    name: null,
    fields: { mode: id.mode },
    tags: {},
    status: 'configured'
  }
}

export async function observeTarget(externalId: string): Promise<Observed | null> {
  return observedTarget(externalId)
}

function secretChanged(desired: DesiredResource): boolean {
  const v = desired.fields.webhook_url as { changed?: boolean } | undefined
  return !!v && typeof v === 'object' && v.changed === true
}

export function planTarget(
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  if (!desired) {
    if (!observed) return []
    return [
      mkOp(
        TARGET,
        null,
        'delete',
        observed.externalId,
        `Delete ${typedName(label, observed.name)}: the Hub forgets the ${observed.fields.mode === 'bot' ? 'conversation' : 'webhook address'} and any notify route that used it stops sending.`
      )
    ]
  }
  const mode = modeOf(desired.fields.mode)
  const name = typedName(label, str(desired.fields.name) ?? observed?.name)
  if (!observed)
    return [
      mkOp(
        TARGET,
        desired,
        'create',
        null,
        mode === 'bot'
          ? `Create ${name}: events go through the Nivaro Teams bot into one conversation (administrators only).`
          : `Create ${name}: events go to a Teams Workflows webhook.`,
        { changes: [{ field: 'mode', to: mode }] }
      )
    ]
  const have = parseTargetId(observed.externalId)
  if (!have || have.mode !== mode)
    return [
      mkOp(
        TARGET,
        desired,
        'replace',
        observed.externalId,
        `Replace ${name}: how it sends cannot be changed, so a new one is made.`,
        { changes: [{ field: 'mode', from: have?.mode ?? null, to: mode }] }
      )
    ]
  const changes: PlannedOp['changes'] = []
  if (mode === 'bot' && have.hash !== botHash(desired)) {
    changes.push({ field: 'conversation_id', to: str(desired.fields.conversation_id) })
    changes.push({ field: 'service_url', to: str(desired.fields.service_url) })
  }
  if (mode === 'webhook' && secretChanged(desired))
    changes.push({ field: 'webhook_url', secret: true })
  if (!changes.length)
    return [mkOp(TARGET, desired, 'noop', observed.externalId, `${name} is up to date.`)]
  return [
    mkOp(TARGET, desired, 'update', observed.externalId, `Change ${name}.`, {
      changes,
      preconditions: {}
    })
  ]
}

/** The target's settings, validated: throws INVALID before anything is stored. */
async function checked(desired: DesiredResource): Promise<TargetMode> {
  const mode = modeOf(desired.fields.mode)
  if (mode === 'webhook') {
    const v = desired.fields.webhook_url as { plain?: string } | undefined
    const problem = webhookUrlProblem(v?.plain)
    if (problem) throw new ProviderError('INVALID', problem)
    return mode
  }
  const problem =
    conversationIdProblem(desired.fields.conversation_id) ??
    serviceUrlProblem(desired.fields.service_url)
  if (problem) throw new ProviderError('INVALID', problem)
  const ready = await botReady()
  if (!ready.ready) throw new ProviderError('BOT_NOT_CONFIGURED', ready.reason)
  return mode
}

const ok = (externalId: string, observed: Observed | null, status: number): OpResult => ({
  ok: true,
  externalId,
  observed,
  answer: { status }
})

export async function createTarget(
  _ctx: ProviderContext,
  desired: DesiredResource
): Promise<OpResult> {
  const mode = await checked(desired)
  const uuid = parseTargetId(desired.externalId ?? '')?.uuid ?? randomUUID()
  const id = `${mode}:${uuid}:${hashOf(mode, desired)}`
  return ok(id, observedTarget(id), 201)
}

export async function updateTarget(
  _ctx: ProviderContext,
  externalId: string,
  desired: DesiredResource
): Promise<OpResult> {
  const have = parseTargetId(externalId)
  if (!have) throw new ProviderError('BAD_ID', 'That is not a Teams notify target id.')
  const mode = modeOf(desired.fields.mode)
  if (mode !== have.mode)
    throw new ProviderError('TARGET_MISMATCH', 'A target cannot change how it sends.')
  const wanted = hashOf(mode, desired)
  const webhook = desired.fields.webhook_url as { plain?: string; changed?: boolean } | undefined
  // A kept webhook address is opened but unchanged: only a new one (or a moved bot conversation)
  // is checked and stored.
  if (mode === 'webhook' && webhook?.changed !== true)
    return ok(externalId, observedTarget(externalId), 200)
  if (mode === 'bot' && wanted === have.hash) return ok(externalId, observedTarget(externalId), 200)
  await checked(desired)
  const id = `${mode}:${have.uuid}:${wanted}`
  return ok(id, observedTarget(id), 200)
}

export async function deleteTarget(_ctx: ProviderContext, externalId: string): Promise<OpResult> {
  // Nothing exists at Microsoft: the Hub forgets it (the engine drops the sealed address).
  return ok(externalId, null, 204)
}

export async function targetHealth(externalId: string, checkedAt: string): Promise<HealthAnswer> {
  const id = parseTargetId(externalId)
  if (!id) return { status: 'down', message: 'This target’s id is not valid.', checkedAt }
  if (id.mode === 'bot') {
    const ready = await botReady()
    return ready.ready
      ? { status: 'ok', checkedAt }
      : { status: 'warn', message: ready.reason, checkedAt }
  }
  return {
    status: 'unknown',
    message: 'A webhook cannot be checked without posting. Use the route’s Test button.',
    checkedAt
  }
}

// ── Sending ──

const SEVERITY_COLOR: Record<OutboundMessage['severity'], string> = {
  info: 'Accent',
  warning: 'Warning',
  critical: 'Attention'
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The adaptive card (schema 1.5) one Hub message makes: title, body, and an Open button. */
export function teamsCard(msg: OutboundMessage): Record<string, unknown> {
  const link = msg.link && /^https:\/\//i.test(msg.link) ? msg.link : null
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'TextBlock',
        text: clip(msg.title, 200),
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
        color: SEVERITY_COLOR[msg.severity] ?? 'Default'
      },
      { type: 'TextBlock', text: clip(msg.body, 2000), wrap: true, spacing: 'Small' }
    ],
    ...(link ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in Nivaro', url: link }] } : {})
  }
}

/** The values of a webhook address that must never appear in text: all of it, its path, its query. */
function webhookSecrets(raw: string): string[] {
  const out = [raw]
  try {
    const u = new URL(raw)
    out.push(u.pathname, u.search, u.search.slice(1))
    for (const [, v] of u.searchParams) out.push(v)
  } catch {
    // not a URL: the whole text is already listed
  }
  return out
}

function statusCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH_FAILED'
  if (status === 404 || status === 410) return 'TARGET_GONE'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 400 || status === 422) return 'INVALID'
  if (status >= 500) return 'PROVIDER_ERROR'
  return 'PROVIDER_REFUSED'
}

async function postWebhook(
  ctx: ProviderContext,
  url: string,
  card: Record<string, unknown>
): Promise<number> {
  const secrets = webhookSecrets(url)
  const clean = (t: string) => clip(scrubValues(ctx.scrub(t), secrets), 300)
  let res: Response
  try {
    res = await ctx.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            contentUrl: null,
            content: card
          }
        ]
      })
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(err.code, clean(err.message), { retryable: err.retryable })
    throw new ProviderError('NETWORK', clean(err instanceof Error ? err.message : String(err)), {
      retryable: true
    })
  }
  if (res.ok) {
    await res.body?.cancel().catch(() => {})
    return res.status
  }
  const text = await res.text().catch(() => '')
  throw new ProviderError(statusCode(res.status), clean(text) || `Teams answered ${res.status}.`, {
    status: res.status,
    retryable: isRetryableStatus(res.status)
  })
}

/** One message through one notify target (the Hub's `notify` call). */
export async function sendTarget(
  ctx: ProviderContext,
  resource: HubResourceRow,
  msg: OutboundMessage
): Promise<OpResult> {
  const id = parseTargetId(resource.external_id ?? '')
  const fields = resource.desired
  if (!id || !fields)
    throw new ProviderError('NOT_CONFIGURED', 'This Teams target has no settings to send with.')
  const card = teamsCard(msg)
  if (id.mode === 'bot') {
    await sendToConversation(
      String(fields.service_url ?? ''),
      String(fields.conversation_id ?? ''),
      card
    )
    return { ok: true, externalId: resource.external_id, observed: null, answer: { sent: true } }
  }
  const stored = fields.webhook_url as { $sealed?: unknown } | undefined
  let url: string | null = null
  try {
    url = typeof stored?.$sealed === 'string' ? openSecret(stored.$sealed) : null
  } catch {
    throw new ProviderError('NOT_CONFIGURED', 'The sealed webhook address could not be opened.')
  }
  const problem = webhookUrlProblem(url)
  if (!url || problem)
    throw new ProviderError('NOT_CONFIGURED', problem ?? 'This target has no webhook address.')
  const status = await postWebhook(ctx, url, card)
  return {
    ok: true,
    externalId: resource.external_id,
    observed: null,
    answer: { status }
  }
}
