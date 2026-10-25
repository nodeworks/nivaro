import { db } from '../db/index.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'
import { ADDENDUM_COLLECTION } from './pipeline-subject.js'
import { QUEUE_SANITY_CEILING } from './queues.js'

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

/**
 * Open records whose current step resolves this user as an owner (#414) —
 * the set their delegate inherits. The SAME resolution My Work and the
 * owned-by-me queue use (bound collections + addenda, open, owner groups with
 * their dimension filters + the binding's owner fallback field), with the
 * ceiling those use. The old "any open instance in a state where I hold a
 * seat" estimate ignored the groups' filters and said 117 for a hand-over of
 * 42 (army 2026-10-24). Delegation is NOT applied: the preview runs before
 * the switch and the briefing right after it, and both describe what the
 * owner holds, not where it currently routes.
 */
export async function countOwnedApprovals(userId: string): Promise<number> {
  const instances = (await db('nivaro_workflow_instances as wi')
    .leftJoin('nivaro_workflow_bindings as b', 'wi.collection', 'b.collection')
    .where((qb) => qb.whereNotNull('b.collection').orWhere('wi.collection', ADDENDUM_COLLECTION))
    .whereNotNull('wi.current_state')
    .whereNull('wi.completed_at')
    .orderBy('wi.id')
    .limit(QUEUE_SANITY_CEILING)
    .select('wi.id as instance_id', 'wi.collection', 'wi.item', 'wi.current_state')) as Array<{
    instance_id: string
    collection: string
    item: string
    current_state: string
  }>
  if (instances.length === 0) return 0
  const owners = await resolveStateOwnersBatch(
    instances.map((i) => ({
      key: `${i.collection}:${i.item}`,
      stateId: i.current_state,
      instanceId: i.instance_id,
      collection: i.collection,
      itemId: i.item
    })),
    db,
    { skipDelegation: true }
  )
  return countOwnedBy(userId, owners)
}

/** Distinct records whose resolved owners include `userId` (case-insensitive ids). */
export function countOwnedBy(userId: string, owners: Map<string, Array<{ id: string }>>): number {
  const me = userId.toUpperCase()
  let n = 0
  for (const set of owners.values()) if (set.some((o) => String(o.id).toUpperCase() === me)) n++
  return n
}

/** Email the delegate a coverage summary when coverage begins (#415). */
export async function sendDelegateBriefing(userId: string, delegateId: string): Promise<void> {
  const [me, delegate] = await Promise.all([
    db('nivaro_users').where({ id: userId }).first('first_name', 'last_name', 'email'),
    db('nivaro_users').where({ id: delegateId }).first('first_name', 'last_name', 'email')
  ])
  if (!delegate?.email) return
  const myName =
    [me?.first_name, me?.last_name].filter(Boolean).join(' ') || me?.email || 'A colleague'
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
  const seatList = seats.map((x) => `<li>${x.template} — ${x.state}</li>`).join('')
  // My Work in whichever app the delegate's links open in (portal or admin).
  const { linkTo } = await import('./app-links.js')
  const myWork = await linkTo('my_work', {}, { recipientUserId: delegateId })
  const { sendRawMail } = await import('./mail.js')
  await sendRawMail({
    to: delegate.email,
    subject: `You're covering for ${myName}`,
    category: 'workflow',
    html: `<p><b>${myName}</b> is out of office and named you their delegate — their approvals now resolve to you.</p>
<p><b>${count}</b> open record(s) sit in steps they own.</p>
${seatList ? `<p>Approval steps they sit in:</p><ul>${seatList}</ul>` : ''}
<p><a href="${myWork}">Open My Work</a> to see what's waiting.</p>`
  })
}
