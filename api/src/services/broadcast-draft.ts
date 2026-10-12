import { scrubText } from './ai-explain.js'

/**
 * "Draft a broadcast" (#2379): the sender writes a few bullets and AI drafts
 * the message for each channel — a short banner line, a fuller email (also
 * the in-app message), an SMS under 160 characters. Nothing is sent: the
 * drafts fill the composer and the sender edits and sends as usual.
 *
 * What reaches the AI provider: the bullets (scrubText) and an audience
 * description of role names, scope-dimension labels and counts — never a
 * recipient's name, email or phone, nor a dimension value's label.
 */

export const SMS_MAX = 160
export const BANNER_MAX = 200
export const SUBJECT_MAX = 120
export const EMAIL_MAX = 4000
const MAX_BULLETS = 20
const MAX_BULLET = 300

export interface AudienceFacts {
  everyone: boolean
  roles: string[]
  /** Scope dimensions by label, with how many values were picked. */
  dimensions: Array<{ label: string; values: number }>
  explicit_people: number
  recipients: number
}

export interface BroadcastDraft {
  banner: string
  email: { subject: string; body: string }
  sms: string
}

/** Bullets from a list or a block of text; scrubbed, trimmed, capped. */
export function cleanBullets(raw: unknown): string[] {
  const list = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? raw.split(/\r?\n/)
      : []
  return list
    .map((b) =>
      scrubText(b)
        .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_BULLET)
    )
    .filter(Boolean)
    .slice(0, MAX_BULLETS)
}

/** The audience as the model may see it: names of roles and dimensions, counts. */
export function describeAudience(a: AudienceFacts): string {
  const parts: string[] = []
  if (a.everyone) parts.push('everyone with an account')
  if (a.roles.length)
    parts.push(`people in the role${a.roles.length > 1 ? 's' : ''} ${a.roles.join(', ')}`)
  for (const d of a.dimensions)
    parts.push(`people scoped to ${d.values} selected ${d.label} value${d.values === 1 ? '' : 's'}`)
  if (a.explicit_people) parts.push(`${a.explicit_people} individually chosen people`)
  return `${parts.join('; ') || 'everyone with an account'} — about ${a.recipients} recipient${a.recipients === 1 ? '' : 's'} in total`
}

export const DRAFT_TOOL = {
  name: 'draft_broadcast',
  description: 'Return the broadcast drafted for each channel.',
  input_schema: {
    type: 'object' as const,
    properties: {
      banner: {
        type: 'string',
        description: `One plain sentence for an in-app banner, at most ${BANNER_MAX} characters.`
      },
      email_subject: { type: 'string', description: `At most ${SUBJECT_MAX} characters.` },
      email_body: {
        type: 'string',
        description:
          'The fuller message: a short greeting-free opening line, then the points as short paragraphs or "- " bullets. Plain text.'
      },
      sms: {
        type: 'string',
        description: `The SMS, plain text, at most ${SMS_MAX} characters including spaces.`
      }
    },
    required: ['banner', 'email_subject', 'email_body', 'sms']
  }
}

export function draftSystemPrompt(): string {
  return `You draft an announcement an administrator will send to people who use this application. Write from the points given and nothing else — never invent dates, names, numbers or links. Fit the tone to the audience and the severity. Call ${DRAFT_TOOL.name} once.`
}

export function draftUserPrompt(
  bullets: string[],
  audience: AudienceFacts,
  channels: string[],
  severity: string
): string {
  return [
    `Severity: ${severity}.`,
    `Audience: ${describeAudience(audience)}.`,
    `Channels the sender picked: ${channels.join(', ') || 'banner'}.`,
    'Points to cover:',
    ...bullets.map((b) => `- ${b}`)
  ].join('\n')
}

/** Cut to `max` characters at a word boundary, with an ellipsis when cut. */
export function fitTo(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** The model's tool input → drafts within every channel's limit. */
export function cleanDraft(input: unknown): BroadcastDraft {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    banner: fitTo(str(i.banner), BANNER_MAX),
    email: {
      subject: fitTo(str(i.email_subject), SUBJECT_MAX),
      body: str(i.email_body).trim().slice(0, EMAIL_MAX)
    },
    sms: fitTo(str(i.sms), SMS_MAX)
  }
}
