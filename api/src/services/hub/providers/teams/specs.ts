import { strs } from '../entra/shared.js'
import type { FieldSpec, PlannedOp, ResourceTypeSpec, RiskFlag } from '../types.js'

/** The Teams resource type specs. Behaviour lives in team.ts, channel.ts, tab.ts and notify.ts. */

export const TEAM = 'teams.team'
export const CHANNEL = 'teams.channel'
export const MEMBERS = 'teams.channel_members'
export const TAB = 'teams.tab'
export const TARGET = 'teams.notify_target'

/** The characters Teams refuses in a channel name. */
export const CHANNEL_NAME_PATTERN = '^[^~#%&*{}+/\\\\:<>?|\'"]{1,50}$'

const textItem: FieldSpec = { key: 'item', label: 'Value', kind: 'string' }

const teamFields: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', readOnly: true },
  { key: 'description', label: 'Description', kind: 'string', readOnly: true },
  { key: 'visibility', label: 'Visibility', kind: 'string', readOnly: true },
  { key: 'archived', label: 'Archived', kind: 'boolean', readOnly: true }
]

const channelFields: FieldSpec[] = [
  {
    key: 'team',
    label: 'Team',
    kind: 'ref',
    refType: TEAM,
    required: true,
    createOnly: true,
    replaceOnChange: true,
    help: 'The team the channel lives in. Teams are shared: adopt one first.'
  },
  {
    key: 'name',
    label: 'Channel name',
    kind: 'string',
    required: true,
    pattern: CHANNEL_NAME_PATTERN,
    max: 50,
    help: 'At most 50 characters; Teams refuses ~ # % & * { } + / \\ : < > ? | and quotes.'
  },
  { key: 'description', label: 'Description', kind: 'string', max: 1024 },
  {
    key: 'membership',
    label: 'Channel type',
    kind: 'enum',
    default: 'standard',
    createOnly: true,
    replaceOnChange: true,
    options: [
      { value: 'standard', label: 'Standard (everyone in the team)' },
      { value: 'private', label: 'Private (only the people added)' }
    ]
  },
  {
    key: 'owner_email',
    label: 'Owner of a private channel',
    kind: 'string',
    createOnly: true,
    help: 'The work email of the person who owns a private channel. Needed when the channel is private: Teams will not make one without an owner.'
  },
  { key: 'web_url', label: 'Link', kind: 'string', readOnly: true }
]

const memberFields: FieldSpec[] = [
  {
    key: 'channel',
    label: 'Channel',
    kind: 'ref',
    refType: CHANNEL,
    required: true,
    createOnly: true,
    replaceOnChange: true,
    help: 'A private channel. A standard channel uses the team’s members.'
  },
  { key: 'name', label: 'Name', kind: 'string', required: true },
  {
    key: 'emails',
    label: 'Members (work emails)',
    kind: 'list',
    items: textItem,
    help: 'People matched by email. An email Entra does not know stops the change and is listed; the Hub never guesses. Owners of the channel are never added or removed here.'
  }
]

const tabFields: FieldSpec[] = [
  {
    key: 'channel',
    label: 'Channel',
    kind: 'ref',
    refType: CHANNEL,
    required: true,
    createOnly: true,
    replaceOnChange: true
  },
  { key: 'name', label: 'Tab name', kind: 'string', required: true, max: 100 },
  {
    key: 'url',
    label: 'Website address',
    kind: 'string',
    required: true,
    help: 'The https address the tab shows (the app’s environment).'
  }
]

const targetFields: FieldSpec[] = [
  { key: 'name', label: 'Name', kind: 'string', required: true, max: 120 },
  {
    key: 'mode',
    label: 'How it sends',
    kind: 'enum',
    default: 'webhook',
    createOnly: true,
    replaceOnChange: true,
    options: [
      { value: 'webhook', label: 'Teams Workflows webhook' },
      { value: 'bot', label: 'Nivaro Teams bot (a conversation it is in)' }
    ]
  },
  {
    key: 'webhook_url',
    label: 'Workflows webhook URL',
    kind: 'secret',
    help: 'From the Teams “Workflows” app: the “Post to a channel when a webhook request is received” template. Sealed at once; the Hub never shows it again.'
  },
  {
    key: 'conversation_id',
    label: 'Bot conversation id',
    kind: 'string',
    help: 'Bot mode: the id of the channel or chat the Nivaro Teams bot is installed in.'
  },
  {
    key: 'service_url',
    label: 'Bot service address',
    kind: 'string',
    help: 'Bot mode: the Microsoft Bot Connector address of that conversation (for example https://smba.trafficmanager.net/amer/).'
  }
]

const CAPS = {
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: false
}

const removedMembers = (op: PlannedOp): boolean => {
  const c = op.changes.find((x) => x.field === 'emails')
  if (!c) return false
  const to = new Set(strs(c.to).map((e) => e.toLowerCase()))
  return strs(c.from).some((e) => !to.has(e.toLowerCase()))
}

function riskDestroy(op: PlannedOp): RiskFlag[] {
  return op.kind === 'delete' || op.kind === 'replace' ? ['destructive'] : []
}

export const TEAMS_TYPES: ResourceTypeSpec[] = [
  {
    key: TEAM,
    label: 'Teams team',
    scope: 'shared',
    fields: teamFields,
    // Read and adopt only: the Hub never creates, changes or deletes a team.
    capabilities: { ...CAPS, create: false, update: false, delete: false },
    reversible: false,
    refs: [],
    risk: () => []
  },
  {
    key: CHANNEL,
    label: 'Teams channel',
    scope: 'app',
    fields: channelFields,
    capabilities: CAPS,
    // Teams keeps a deleted channel for 30 days: it can be restored there.
    reversible: true,
    refs: [{ field: 'team', type: TEAM, required: true }],
    risk: (op) => riskDestroy(op)
  },
  {
    key: MEMBERS,
    label: 'Teams channel members',
    scope: 'app',
    fields: memberFields,
    capabilities: { ...CAPS, adopt: false },
    reversible: true,
    refs: [{ field: 'channel', type: CHANNEL, required: true }],
    risk: (op) => (op.kind === 'replace' || removedMembers(op) ? ['destructive'] : [])
  },
  {
    key: TAB,
    label: 'Teams website tab',
    scope: 'app',
    fields: tabFields,
    capabilities: { ...CAPS, adopt: false },
    reversible: true,
    refs: [{ field: 'channel', type: CHANNEL, required: true }],
    risk: (op) => riskDestroy(op)
  },
  {
    key: TARGET,
    label: 'Teams notify target',
    scope: 'app',
    fields: targetFields,
    // Nothing exists at Microsoft: the Hub holds the webhook address or the bot conversation.
    capabilities: { ...CAPS, adopt: false },
    reversible: true,
    refs: [],
    sends: true,
    risk: (op, desired) => {
      const flags = new Set<RiskFlag>()
      if (op.kind === 'delete' || op.kind === 'replace') flags.add('destructive')
      // The bot posts as the Hub's own app into a conversation picked by id: administrators only.
      if (op.kind !== 'delete' && desired?.fields.mode === 'bot') flags.add('public_exposure')
      return [...flags]
    }
  }
]
