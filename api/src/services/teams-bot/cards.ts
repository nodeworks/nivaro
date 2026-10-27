// Adaptive Cards (schema 1.5) for the Teams bot. Buttons are Action.Execute with verb 'nivaro';
// the invoke handler reads data = { kind, ref, action, nonce } (spec §6.1). Cards carry only what
// the notification text already shows — no field values, no secrets.

export const CARD_MAX_BYTES = 24 * 1024
const OPEN_IN_NIVARO = '… Open in Nivaro'

export interface CardAction {
  kind: 'approval' | 'transition' | 'ack'
  /** approval: instance id · transition: "collection/item" · ack: notification id */
  ref: string
  /** approval: approved | rejected · transition: transition id · ack: ack */
  action: string
  label: string
  needsComment?: boolean
  /** Fresh random per card; the invoke handler accepts each one once. */
  nonce: string
}

export interface AdaptiveCard {
  $schema: string
  type: 'AdaptiveCard'
  version: '1.5'
  body: Array<Record<string, unknown>>
  actions?: Array<Record<string, unknown>>
}

export interface NotificationCardInput {
  subject: string
  message: string
  categoryLabel: string
  recordLabel?: string | null
  stateLabel?: string | null
  openUrl: string
  actions: CardAction[]
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const size = (c: unknown) => Buffer.byteLength(JSON.stringify(c), 'utf8')

function shell(body: Array<Record<string, unknown>>, actions: Array<Record<string, unknown>>) {
  const card: AdaptiveCard = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body
  }
  if (actions.length) card.actions = actions
  return card
}

function executeAction(a: CardAction): Record<string, unknown> {
  return {
    type: 'Action.Execute',
    title: clip(a.label, 60),
    verb: 'nivaro',
    // Only the buttons that need the comment box send (and validate) it.
    associatedInputs: a.needsComment ? 'auto' : 'none',
    ...(a.kind === 'approval' && a.action === 'approved' ? { style: 'positive' } : {}),
    ...(a.kind === 'approval' && a.action === 'rejected' ? { style: 'destructive' } : {}),
    data: { kind: a.kind, ref: a.ref, action: a.action, nonce: a.nonce }
  }
}

export function notificationCard(n: NotificationCardInput): AdaptiveCard {
  const context = [n.recordLabel, n.stateLabel].filter(Boolean).join(' · ')
  const build = (message: string) => {
    const body: Array<Record<string, unknown>> = [
      {
        type: 'TextBlock',
        text: clip(n.categoryLabel, 80),
        size: 'Small',
        isSubtle: true,
        wrap: true
      },
      {
        type: 'TextBlock',
        text: clip(n.subject, 300),
        weight: 'Bolder',
        size: 'Medium',
        wrap: true
      }
    ]
    if (context)
      body.push({ type: 'TextBlock', text: clip(context, 300), isSubtle: true, wrap: true })
    if (message) body.push({ type: 'TextBlock', text: message, wrap: true })
    if (n.actions.some((a) => a.needsComment))
      body.push({
        type: 'Input.Text',
        id: 'comment',
        placeholder: 'Reason (required to reject)',
        isMultiline: true,
        isRequired: true,
        errorMessage: 'A reason is required'
      })
    const actions: Array<Record<string, unknown>> = [
      ...n.actions.map(executeAction),
      { type: 'Action.OpenUrl', title: 'Open in Nivaro', url: n.openUrl }
    ]
    return shell(body, actions)
  }

  const message = n.message ?? ''
  let card = build(message)
  // Over the cap: cut the message (the only unbounded part) until it fits. Removing `over`
  // characters removes at least `over` bytes, so each pass makes progress.
  let keep = message.length
  while (size(card) > CARD_MAX_BYTES && keep > 0) {
    keep = Math.max(0, keep - Math.max(size(card) - CARD_MAX_BYTES, 64))
    card = build(keep > 0 ? `${message.slice(0, keep)}${OPEN_IN_NIVARO}` : '')
  }
  return card
}

export function resultCard(text: string, openUrl?: string): AdaptiveCard {
  return shell(
    [{ type: 'TextBlock', text: clip(text, 2000), wrap: true }],
    openUrl ? [{ type: 'Action.OpenUrl', title: 'Open in Nivaro', url: openUrl }] : []
  )
}
