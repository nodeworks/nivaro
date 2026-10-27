// The slice of a Bot Framework activity the Nivaro bot reads. Everything is optional: the body
// is attacker-shaped until the Connector token has been verified, and Teams omits fields freely.

export interface TeamsAccount {
  id?: string
  aadObjectId?: string
  name?: string
}

/** An @mention: Teams puts `<at>Name</at>` in the text and this entity beside it. */
export interface TeamsEntity {
  type?: string
  mentioned?: { id?: string; name?: string }
  text?: string
}

export interface TeamsActivity {
  type?: string
  id?: string
  name?: string
  channelId?: string
  serviceUrl?: string
  conversation?: { id?: string; conversationType?: string; tenantId?: string }
  from?: TeamsAccount
  recipient?: TeamsAccount
  text?: string
  entities?: TeamsEntity[]
  value?: unknown
  membersAdded?: TeamsAccount[]
  membersRemoved?: TeamsAccount[]
  action?: string
  channelData?: {
    tenant?: { id?: string }
    team?: { id?: string; name?: string }
    /** membershipType: 'standard' | 'private' | 'shared' (Teams). */
    channel?: { id?: string; name?: string; membershipType?: string }
  }
  replyToId?: string
}

const innerOf = (tag: string) => tag.replace(/<\/?at>/gi, '')

/**
 * The words a person typed, ready to match a command or ask: the bot's OWN mention (the mention
 * entity whose id is the recipient's) is dropped, every other mention keeps its name as plain
 * text ("how many does <at>Sam</at> have" → "how many does Sam have"), `&nbsp;` is a space.
 */
export function messageText(activity: TeamsActivity): string {
  let text = String(activity.text ?? '')
  const botId = activity.recipient?.id
  for (const e of activity.entities ?? []) {
    if (e?.type !== 'mention' || typeof e.text !== 'string' || !e.text) continue
    const own = !!botId && e.mentioned?.id === botId
    text = text.split(e.text).join(own ? ' ' : innerOf(e.text))
  }
  return text
    .replace(/<at>([\s\S]*?)<\/at>/gi, '$1')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
