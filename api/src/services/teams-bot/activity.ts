// The slice of a Bot Framework activity the Nivaro bot reads. Everything is optional: the body
// is attacker-shaped until the Connector token has been verified, and Teams omits fields freely.

export interface TeamsAccount {
  id?: string
  aadObjectId?: string
  name?: string
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
  value?: unknown
  membersAdded?: TeamsAccount[]
  membersRemoved?: TeamsAccount[]
  action?: string
  channelData?: {
    tenant?: { id?: string }
    team?: { id?: string; name?: string }
    channel?: { id?: string; name?: string }
  }
  replyToId?: string
}
