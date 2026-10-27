import { randomUUID } from 'node:crypto'
import { NOTIFY_CATEGORY_LABELS, type NotifyCategory } from '../notification-channels.js'
import type { NotificationTargetSpec } from '../notification-target.js'
import { type AdaptiveCard, type CardAction, notificationCard } from './cards.js'

const MAX_TRANSITION_BUTTONS = 3

export interface TeamsNotificationInput {
  userId: string
  notificationId: number | null
  subject: string
  message: string
  category: NotifyCategory
  collection?: string | null
  item?: string | number | null
  target: NotificationTargetSpec | null
  ackRequired?: boolean
  openUrl: string
}

/**
 * The card for one notification, built for its recipient. Buttons appear only when the
 * notification carries something to do (spec §5.2): a pending approval step for this person,
 * manual transitions they may run, an acknowledgement. Anything that goes wrong while looking
 * for extras leaves a plain card — delivery never depends on them.
 */
export async function buildTeamsNotificationCard(i: TeamsNotificationInput): Promise<AdaptiveCard> {
  const actions: CardAction[] = []
  let recordLabel: string | null = null
  let stateLabel: string | null = null
  try {
    const t = i.target
    // The approvals engine names the instance in the target (kind 'approval', action 'review').
    if (t?.kind === 'approval' && t.action === 'review' && t.instance_id != null) {
      const ref = String(t.instance_id)
      actions.push(
        { kind: 'approval', ref, action: 'approved', label: 'Approve', nonce: randomUUID() },
        {
          kind: 'approval',
          ref,
          action: 'rejected',
          label: 'Reject',
          needsComment: true,
          nonce: randomUUID()
        }
      )
    }

    const collection = (t?.collection ?? i.collection) || null
    const item = t?.id ?? i.item
    if (
      collection &&
      item != null &&
      !collection.startsWith('nivaro_') &&
      !collection.startsWith('__')
    ) {
      const extras = await recordExtras(i.userId, collection, String(item), t?.kind === 'record')
      recordLabel = extras.recordLabel
      stateLabel = extras.stateLabel
      actions.push(...extras.transitions)
    }
  } catch {
    // plain card
  }
  if (i.ackRequired && i.notificationId != null)
    actions.push({
      kind: 'ack',
      ref: String(i.notificationId),
      action: 'ack',
      label: 'Acknowledge',
      nonce: randomUUID()
    })

  return notificationCard({
    subject: i.subject,
    message: i.message,
    categoryLabel: NOTIFY_CATEGORY_LABELS[i.category] ?? 'Notification',
    recordLabel,
    stateLabel,
    openUrl: i.openUrl,
    actions
  })
}

async function recordExtras(
  userId: string,
  collection: string,
  item: string,
  offerTransitions: boolean
): Promise<{ recordLabel: string | null; stateLabel: string | null; transitions: CardAction[] }> {
  const none = { recordLabel: null, stateLabel: null, transitions: [] as CardAction[] }
  const [{ getUser }, { instanceAccessAllowed }, { isAdminRole }] = await Promise.all([
    import('../users.js'),
    import('../instance-guard.js'),
    import('../permissions.js')
  ])
  const user = await getUser(userId)
  if (!user) return none
  const isAdmin = await isAdminRole(user)
  // As the recipient: a record they cannot read contributes no label, state or button.
  if (!(await instanceAccessAllowed(user, isAdmin, collection, item, 'read'))) return none

  const { getLabels } = await import('../queues.js')
  const labels = await getLabels(new Map([[collection, new Set([item])]])).catch(
    () => ({}) as Record<string, string>
  )
  const recordLabel = labels[`${collection}:${item}`] ?? null

  const { findRecordInstance } = await import('../branch-instances.js')
  const instance = await findRecordInstance<{
    id: string
    collection: string
    item: string
    template: string
    current_state: string
  }>(collection, item)
  if (!instance) return { ...none, recordLabel }

  // Same loader and role test as GET /pipelines/:id/outline.
  const { loadPipelineOutline } = await import('../pipeline-outline-load.js')
  const outline = await loadPipelineOutline(instance.template, {
    isAdmin,
    role: (user.role as string | null | undefined) ?? null
  })
  if (!outline) return { ...none, recordLabel }
  const stateLabel = outline.states.find((s) => s.id === instance.current_state)?.label ?? null
  if (
    !offerTransitions ||
    !(await instanceAccessAllowed(user, isAdmin, collection, item, 'update'))
  )
    return { recordLabel, stateLabel, transitions: [] }

  // A card is a one-click surface: it offers only what list surfaces offer (in_row_menu, migration 312).
  const { db } = await import('../../db/index.js')
  const menu = (await db('nivaro_workflow_transitions')
    .where({ template: instance.template })
    .select('id', 'in_row_menu')) as Array<{ id: string; in_row_menu: unknown }>
  const oneClick = new Set(
    menu
      .filter((r) => r.in_row_menu == null || r.in_row_menu === true || r.in_row_menu === 1)
      .map((r) => String(r.id))
  )
  const transitions: CardAction[] = outline.transitions
    // Owner-only moves are left to the record page: the owner test is per record.
    .filter(
      (t) =>
        !t.require_owner &&
        oneClick.has(String(t.id)) &&
        (t.from_state === null || t.from_state === instance.current_state)
    )
    .slice(0, MAX_TRANSITION_BUTTONS)
    .map((t) => ({
      kind: 'transition' as const,
      ref: `${collection}/${item}`,
      action: t.id,
      label: t.label,
      nonce: randomUUID()
    }))
  return { recordLabel, stateLabel, transitions }
}
