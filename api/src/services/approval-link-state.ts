import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { esc, timeTag } from './public-live-page.js'

/**
 * What a decision link's landing page says about its approval (realtime round 9, item 21):
 * where the approval stands now, read fresh on every load and every live refresh. A decision
 * link is handed to ONE approver (email or Teams), so the page names the chain, the step and
 * the people who decided. The record is named by its label only to a viewer who can read it,
 * read as them (routes/message-actions.ts) — never other record values.
 */

export type LinkStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'gone'

export interface LinkDecision {
  decision: 'approved' | 'rejected'
  by: string
  at: string
  step_label: string
  /** Made by the person the link was sent to. */
  mine: boolean
}

export interface ApprovalLinkState {
  status: LinkStatus
  chain_name: string
  /** The step waiting now (pending only). */
  step_label: string | null
  step_number: number
  step_count: number
  /** Newest decision on the approval. */
  last: LinkDecision | null
  /** The link holder's newest decision. */
  mine: LinkDecision | null
  /** Pending, the current step is the holder's, and they have not decided it. */
  waiting_on_holder: boolean
  /** Redacted for a reader who is not signed in as someone who can read the record: no
   *  names, no times (redactLinkState). */
  anonymous?: boolean
}

/** What a link holder who is NOT signed in (or cannot read the record) may see: whether it is
 *  decided and the current step's label — never who decided or when. Pure. */
export function redactLinkState(s: ApprovalLinkState): ApprovalLinkState {
  return { ...s, last: null, mine: null, anonymous: true }
}

const sameId = (a: unknown, b: unknown) =>
  a != null && b != null && String(a).toUpperCase() === String(b).toUpperCase()

const nameOf = (u: { first_name?: string | null; last_name?: string | null } | undefined) =>
  [u?.first_name, u?.last_name].filter(Boolean).join(' ').trim() || 'Someone'

export async function loadApprovalLinkState(
  instanceId: number,
  holderId: string | null
): Promise<ApprovalLinkState> {
  const gone: ApprovalLinkState = {
    status: 'gone',
    chain_name: '',
    step_label: null,
    step_number: 0,
    step_count: 0,
    last: null,
    mine: null,
    waiting_on_holder: false
  }
  if (!Number.isFinite(instanceId)) return gone
  const inst = (await db('nivaro_approval_instances as i')
    .join('nivaro_approval_chains as c', 'c.id', 'i.chain')
    .where('i.id', instanceId)
    .first('i.id', 'i.chain', 'i.current_step', 'i.status', 'c.name as chain_name')) as
    | { id: number; chain: number; current_step: number; status: string; chain_name: string }
    | undefined
  if (!inst) return gone
  const [steps, decisions, holder] = await Promise.all([
    db('nivaro_approval_chain_steps')
      .where({ chain: inst.chain })
      .orderBy('step_order', 'asc')
      .select('step_order', 'label', 'approver', 'approver_role') as Promise<
      Array<{
        step_order: number
        label: string | null
        approver: string | null
        approver_role: string | null
      }>
    >,
    db('nivaro_approval_decisions as d')
      .leftJoin('nivaro_users as u', 'u.id', 'd.user')
      .where('d.instance', inst.id)
      .orderBy('d.id', 'desc')
      .limit(50)
      .select(
        'd.id',
        'd.step_order',
        'd.user',
        'd.decision',
        'd.decided_at',
        'u.first_name',
        'u.last_name'
      ) as Promise<
      Array<{
        id: number
        step_order: number
        user: string
        decision: string
        decided_at: Date | string
        first_name: string | null
        last_name: string | null
      }>
    >,
    holderId
      ? (db('nivaro_users').where({ id: holderId }).first('id', 'role') as Promise<
          { id: string; role: string | null } | undefined
        >)
      : Promise.resolve(undefined)
  ])
  const labelOf = (order: number) =>
    steps.find((s) => s.step_order === order)?.label ?? `Step ${order + 1}`
  const toDecision = (d: (typeof decisions)[number]): LinkDecision => ({
    decision: d.decision === 'rejected' ? 'rejected' : 'approved',
    by: nameOf(d),
    at: new Date(d.decided_at).toISOString(),
    step_label: labelOf(d.step_order),
    mine: sameId(d.user, holderId)
  })
  const status: LinkStatus =
    inst.status === 'approved' || inst.status === 'rejected' || inst.status === 'pending'
      ? inst.status
      : 'cancelled'
  const current = steps.find((s) => s.step_order === inst.current_step)
  const holderStep =
    !!current &&
    !!holder &&
    (sameId(current.approver, holder.id) ||
      (!!current.approver_role && sameId(current.approver_role, holder.role)))
  const decidedCurrent = decisions.some(
    (d) => d.step_order === inst.current_step && sameId(d.user, holderId)
  )
  const mineRow = decisions.find((d) => sameId(d.user, holderId))
  return {
    status,
    chain_name: inst.chain_name,
    step_label: status === 'pending' ? labelOf(inst.current_step) : null,
    step_number:
      Math.max(
        0,
        steps.findIndex((s) => s.step_order === inst.current_step)
      ) + 1,
    step_count: steps.length,
    last: decisions[0] ? toDecision(decisions[0]) : null,
    mine: mineRow ? toDecision(mineRow) : null,
    waiting_on_holder: status === 'pending' && holderStep && !decidedCurrent
  }
}

/** A stable fingerprint of what the page shows — the stream signals only when it moves. */
export function linkStateSignature(s: ApprovalLinkState): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        s.status,
        s.step_label,
        s.step_number,
        s.last?.at,
        s.last?.decision,
        s.mine?.at,
        s.waiting_on_holder
      ])
    )
    .digest('hex')
}

export type Tone = 'ok' | 'bad' | 'wait' | 'ask' | 'muted'

export interface LinkHeadline {
  tone: Tone
  title: string
  /** "by Beth Lee at <time>" when a person decided. `lead` names what they decided ("Manager
   *  sign-off approved") when it is not the headline itself — a waiting headline never carries
   *  a bare "by <person>" (it would read as if that person were holding it up). */
  by?: { name: string; at: string; lead?: string } | null
  note?: string | null
  /** The decide buttons may show (the page adds them only for the signed-in approver). */
  decidable: boolean
}

/** The sentence the page leads with. Pure (tested). `verb` = the link's own action. */
export function linkHeadline(s: ApprovalLinkState, verb: 'approve' | 'reject'): LinkHeadline {
  const by = (d: LinkDecision | null) => (d ? { name: d.mine ? 'you' : d.by, at: d.at } : null)
  if (s.anonymous && (s.status === 'approved' || s.status === 'rejected'))
    return {
      tone: 'muted',
      title: 'This approval has already been decided',
      by: null,
      note: 'Open it in Nivaro to see who decided and when.',
      decidable: false
    }
  if (s.anonymous && s.status === 'pending' && !s.waiting_on_holder)
    return {
      tone: 'wait',
      title: `Waiting on ${s.step_label ?? 'the next step'}`,
      by: null,
      note: 'Open it in Nivaro to see more.',
      decidable: false
    }
  switch (s.status) {
    case 'gone':
      return {
        tone: 'muted',
        title: 'This request is no longer here',
        note: 'It was removed. Nothing is waiting on you.',
        decidable: false
      }
    case 'approved':
      return {
        tone: 'ok',
        title: s.last?.mine ? 'You approved this' : 'Already approved',
        by: s.last?.mine ? { name: '', at: s.last.at } : by(s.last),
        note: 'Every step is signed off. Nothing more to do.',
        decidable: false
      }
    case 'rejected':
      return {
        tone: 'bad',
        title: s.last?.mine ? 'You rejected this' : 'Already rejected',
        by: s.last?.mine ? { name: '', at: s.last.at } : by(s.last),
        note: s.last?.step_label ? `Stopped at ${s.last.step_label}. Nothing more to do.` : null,
        decidable: false
      }
    case 'cancelled':
      return {
        tone: 'muted',
        title: 'This approval was withdrawn',
        note: 'Nothing is waiting on you.',
        decidable: false
      }
    default:
      break
  }
  if (s.waiting_on_holder) {
    return {
      tone: 'ask',
      title: `${verb === 'approve' ? 'Approve' : 'Reject'} ${s.step_label ?? 'this step'}?`,
      by: null,
      note:
        s.step_count > 1
          ? `Step ${s.step_number} of ${s.step_count}${
              s.last && !s.last.mine ? ` · ${s.last.step_label} approved by ${s.last.by}` : ''
            }.`
          : null,
      decidable: true
    }
  }
  if (s.mine) {
    return {
      tone: 'ok',
      title: s.mine.decision === 'approved' ? 'You approved your step' : 'You rejected your step',
      by: { name: '', at: s.mine.at },
      note: `Now waiting on ${s.step_label ?? 'the next step'}.`,
      decidable: false
    }
  }
  return {
    tone: 'wait',
    title: `Waiting on ${s.step_label ?? 'the next step'}`,
    by: s.last
      ? {
          lead: `${s.last.step_label} ${s.last.decision === 'rejected' ? 'rejected' : 'approved'}`,
          name: s.last.by,
          at: s.last.at
        }
      : null,
    note: 'This step is not yours to decide. Nothing is waiting on you.',
    decidable: false
  }
}

/** The live block's HTML. `form` = the decide form (only for the signed-in approver). */
export function linkStateHtml(h: LinkHeadline, extra: { formHtml?: string; openUrl?: string }) {
  const byLine = h.by
    ? `<p class="by">${h.by.lead ? `${esc(h.by.lead)} ` : ''}${h.by.name ? `by <strong>${esc(h.by.name)}</strong> ` : ''}at ${timeTag(h.by.at)}</p>`
    : ''
  const toneClass = h.tone === 'muted' ? '' : `tone-${h.tone}`
  return `<div class="state ${toneClass}"><span class="dot" aria-hidden="true"></span><div>
<h1>${esc(h.title)}</h1>${byLine}${h.note ? `<p class="note">${esc(h.note)}</p>` : ''}
${extra.formHtml ?? ''}${
  extra.openUrl
    ? `<p class="note"><a href="${esc(extra.openUrl)}" data-k="open">Open in Nivaro</a></p>`
    : ''
}</div></div>`
}
