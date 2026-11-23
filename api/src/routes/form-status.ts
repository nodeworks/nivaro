import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { registerAppKeyed } from '../services/app-forget.js'
import {
  esc,
  publicLiveCsp,
  publicLivePageHtml,
  publicMessagePageHtml,
  timeTag
} from '../services/public-live-page.js'
import { SignalStreamRoute, sharedSignature } from '../services/public-signal-stream.js'
import {
  loadPublicStatus,
  type PublicStage,
  type PublicStatus,
  type ResolvedStatusLink,
  resolveStatusLink,
  STAGE_LABELS
} from '../services/submission-status.js'
import { currentTenantKey } from '../services/tenant-rooms.js'
import { takeBudget } from '../services/widget-live.js'
import { overWindowLimit } from '../services/windowed-limit.js'

/**
 * Public submission status page (realtime round 9, item 22): `/form-status/:token` and its
 * token-scoped live stream. Unauthenticated by design — the signed, expiring, per-submission
 * token IS the access (services/submission-status.ts) — and it shows only the stage the form
 * owner mapped as public. Sits outside /api like /form/:token and /share/:token.
 */

const PAGE_VIEWS_PER_10_MIN = 120
const STREAMS_PER_IP = 10
const sigs = registerAppKeyed(new Map<string, { at: number; sig: Promise<string | null> }>())

const ORDER: PublicStage[] = ['received', 'in_review', 'decided']

const NOTE: Record<PublicStage, string> = {
  received: 'Nobody has picked it up yet. This page changes as soon as someone does.',
  in_review: 'Someone is working on it. You do not need to do anything.',
  decided: 'This request is closed. Nothing more is needed from you.'
}

/** A refusal gets its own next step, never the same line as a yes. */
const REFUSED_NOTE =
  'This request was not approved. If you still need it, send a new request or contact whoever shared the form with you.'

/** A decided label that reads as a refusal ("Rejected", "Declined", "Not approved"). Pure. */
const REFUSAL = /\b(reject|declin|denied|deny|refus|not approved|unsuccessful|cancel|withdrawn)/i

/** The outcome's colour: green for a yes, red for a no, the accent for a neutral close. */
export function decidedTone(label: string): 'tone-ok' | 'tone-bad' | 'tone-done' {
  if (REFUSAL.test(label)) return 'tone-bad'
  if (/\b(approv|accept|grant|complet|done|resolv|success)/i.test(label)) return 'tone-ok'
  return 'tone-done'
}

/** The live block. Pure (tested). The track always names the three stages the same way — the
 *  owner's label for where it stands is the headline, never a fourth step name. */
export function statusBlockHtml(link: ResolvedStatusLink, st: PublicStatus): string {
  if (st.gone)
    return `<div class="state"><span class="dot" aria-hidden="true"></span><div><h1>This request is no longer available</h1><p class="note">It may have been withdrawn or removed. If you still need it, send the form again or contact whoever shared it with you.</p></div></div>`
  const at = ORDER.indexOf(st.stage)
  const tone =
    st.stage === 'decided'
      ? decidedTone(st.label)
      : st.stage === 'in_review'
        ? 'tone-wait'
        : 'tone-ask'
  const steps = ORDER.map((s, i) => {
    const cls = i < at ? 'done' : i === at ? 'now' : ''
    return `<li class="${cls}"${i === at ? ' aria-current="step"' : ''}>${esc(STAGE_LABELS[s])}</li>`
  }).join('')
  const when = st.stage === 'decided' && st.since ? ` · Decided ${timeTag(st.since)}` : ''
  return `<div class="state ${tone}"><span class="dot" aria-hidden="true"></span><div>
<h1>${esc(st.label)}</h1><p class="by">Submitted ${timeTag(link.createdAt)}${when}</p></div></div>
<ol class="track at${at} ${tone}" aria-label="Progress">${steps}</ol>
<p class="note">${esc(tone === 'tone-bad' ? REFUSED_NOTE : NOTE[st.stage])}</p>`
}

function signatureOf(st: PublicStatus): string {
  return createHash('sha256')
    .update(JSON.stringify([st.gone, st.stage, st.label, st.since ?? null]))
    .digest('hex')
}

export async function formStatusPublicRoutes(app: FastifyInstance) {
  const notFound = () =>
    publicMessagePageHtml(
      'This link is not valid',
      'It may have expired or been mistyped. Open the link from your email again, or contact whoever shared the form with you.'
    )

  app.get<{ Params: { token: string } }>('/form-status/:token', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer')
    if (
      await overWindowLimit(
        app.redis,
        `form-status-view:${currentTenantKey()}:${req.ip || 'unknown'}`,
        PAGE_VIEWS_PER_10_MIN,
        600
      )
    ) {
      return reply
        .code(429)
        .header('content-security-policy', publicLiveCsp('none'))
        .type('text/html')
        .send(publicMessagePageHtml('Too many requests', 'Wait a few minutes, then reload.'))
    }
    const link = await resolveStatusLink(req.params.token)
    if (!link)
      return reply
        .code(404)
        .header('content-security-policy', publicLiveCsp('none'))
        .type('text/html')
        .send(notFound())
    const st = await loadPublicStatus(link)
    const nonce = randomBytes(16).toString('base64url')
    const self = `/form-status/${encodeURIComponent(req.params.token)}`
    return reply
      .header('content-security-policy', publicLiveCsp(nonce))
      .type('text/html')
      .send(
        publicLivePageHtml({
          title: st.gone ? 'Request unavailable' : `${st.label} · ${link.formName}`,
          context: link.formName,
          liveHtml: statusBlockHtml(link, st),
          nonce,
          streamUrl: st.gone || st.stage === 'decided' ? null : `${self}/stream`,
          refreshUrl: self
        })
      )
  })

  // ── GET /form-status/:token/stream — bare "changed" while the page is open ────
  const streams = new SignalStreamRoute()
  app.addHook('preClose', async () => {
    streams.closeAll()
  })
  app.get<{ Params: { token: string } }>(
    '/form-status/:token/stream',
    { compress: false } as never,
    async (req, reply) => {
      const token = req.params.token
      await streams.serve(req, reply, {
        perIp: STREAMS_PER_IP,
        heartbeatMs: 25_000,
        coalesceMs: 1_000,
        async open() {
          const link = await resolveStatusLink(token)
          if (!link) return { ok: false, code: 404, body: { error: 'Not found' } }
          const tenant = currentTenantKey()
          const item = link.item.toLowerCase()
          return {
            ok: true,
            subject: {
              watches: (ev) =>
                ev.collection === link.collection &&
                (ev.item === '*' || String(ev.item).toLowerCase() === item),
              // Budgeted like every public stream (share links, embeds).
              signature: () =>
                sharedSignature(
                  sigs,
                  `${tenant}|${link.submissionId}`,
                  async () => signatureOf(await loadPublicStatus(link)),
                  { budget: () => takeBudget(tenant) }
                ),
              // Expired, switched off or removed: the page reloads into "not valid".
              stillServes: async () => !!(await resolveStatusLink(token))
            }
          }
        }
      })
    }
  )
}
