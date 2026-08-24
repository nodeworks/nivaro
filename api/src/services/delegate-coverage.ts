import { db } from '../db/index.js'
import { config } from '../config.js'

/**
 * Delegation coverage helpers: #338 OOO conflict warnings, #414 delegation
 * preview, #415 delegate briefing.
 */

/** Owner groups where this user is the LAST working member (#338). */
export async function computeCoverageWarnings(userId: string): Promise<string[]> {
  const myGroups = (await db('nivaro_pipeline_owner_group_users as gu')
    .join('nivaro_pipeline_owner_groups as g', 'gu.group', 'g.id')
    .join('nivaro_workflow_states as s', 'g.state', 's.id')
    .where('gu.user', userId)
    .limit(300)
    .select('g.id as gid', 'g.name as gname', 's.label as state_label')) as Array<{
    gid: number
    gname: string | null
    state_label: string
  }>
  if (myGroups.length === 0) return []
  const warnings: string[] = []
  for (const g of myGroups.slice(0, 100)) {
    const others = (await db('nivaro_pipeline_owner_group_users as gu')
      .join('nivaro_users as u', 'u.id', 'gu.user')
      .where('gu.group', g.gid)
      .whereNot('gu.user', userId)
      .select('u.is_out_of_office', 'u.status')) as Array<{
      is_out_of_office: boolean | number
      status: string | null
    }>
    const working = others.filter(
      (o) =>
        !(o.is_out_of_office === true || o.is_out_of_office === 1) &&
        String(o.status ?? '').toLowerCase() !== 'suspended'
    )
    if (working.length === 0) {
      warnings.push(
        `"${g.gname ?? g.state_label}" (${g.state_label}) has no other working member — approvals there stall while you're out unless your delegate covers them.`
      )
    }
    if (warnings.length >= 10) break
  }
  return warnings
}

/** Approximate count of open records the user currently owns (#414). */
export async function countOwnedApprovals(userId: string): Promise<number> {
  // Owner-group membership × open instances in those states — an upper-bound
  // estimate (dimension filters may exclude some), computed cheaply.
  const rows = (await db('nivaro_pipeline_owner_group_users as gu')
    .join('nivaro_pipeline_owner_groups as g', 'gu.group', 'g.id')
    .where('gu.user', userId)
    .distinct('g.state')) as Array<{ state: string }>
  if (rows.length === 0) return 0
  const counts = (await db('nivaro_workflow_instances')
    .whereIn(
      'current_state',
      rows.map((r) => r.state)
    )
    .whereNull('completed_at')
    .count('* as c')
    .first()) as { c?: number | string } | undefined
  return Number(counts?.c ?? 0)
}

/** Email the delegate a coverage summary when coverage begins (#415). */
export async function sendDelegateBriefing(userId: string, delegateId: string): Promise<void> {
  const [me, delegate] = await Promise.all([
    db('nivaro_users').where({ id: userId }).first('first_name', 'last_name', 'email'),
    db('nivaro_users').where({ id: delegateId }).first('first_name', 'last_name', 'email')
  ])
  if (!delegate?.email) return
  const myName = [me?.first_name, me?.last_name].filter(Boolean).join(' ') || me?.email || 'A colleague'
  const count = await countOwnedApprovals(userId)
  const seats = (await db('nivaro_pipeline_owner_group_users as gu')
    .join('nivaro_pipeline_owner_groups as g', 'gu.group', 'g.id')
    .join('nivaro_workflow_states as s', 'g.state', 's.id')
    .join('nivaro_workflow_templates as t', 's.template', 't.id')
    .where('gu.user', userId)
    .limit(15)
    .select('t.name as template', 's.label as state')) as Array<{
    template: string
    state: string
  }>
  const seatList = seats
    .map((x) => `<li>${x.template} — ${x.state}</li>`)
    .join('')
  const { sendRawMail } = await import('./mail.js')
  await sendRawMail({
    to: delegate.email,
    subject: `You're covering for ${myName}`,
    html: `<p><b>${myName}</b> is out of office and named you their delegate — their approvals now resolve to you.</p>
<p>Roughly <b>${count}</b> open record(s) sit in steps they own.</p>
${seatList ? `<p>Approval steps they sit in:</p><ul>${seatList}</ul>` : ''}
<p><a href="${config.ADMIN_URL}/my-work">Open My Work</a> to see what's waiting.</p>`
  })
}
