/**
 * Machine identities.
 *
 * Some rows in nivaro_users are not people: an integration's token identity,
 * the chat bot, a service login, a placeholder kept only so old foreign keys
 * resolve. For a long time that was a CONVENTION — an `@nivaro.local` address,
 * the word "integration" in an email, a suspended status — re-implemented
 * wherever it mattered, each copy slightly different. `nivaro_users.account_kind`
 * (migration 332) states it; NULL means a person.
 *
 * The explicit column always wins. The conventions remain only as a fallback
 * for rows nobody has classified, so an integration whose address looks like a
 * person's is one PATCH away from being treated correctly everywhere.
 */

export const ACCOUNT_KINDS = ['integration', 'bot', 'service', 'placeholder'] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export const BOT_EMAIL = 'chat-bot@nivaro.local'

export interface AccountLike {
  account_kind?: string | null
  email?: string | null
}

export function isAccountKind(value: unknown): value is AccountKind {
  return typeof value === 'string' && (ACCOUNT_KINDS as readonly string[]).includes(value)
}

/** What an unclassified address implies. Never consulted when the column is set. */
export function accountKindFromEmail(email: string | null | undefined): AccountKind | null {
  const e = String(email ?? '')
    .trim()
    .toLowerCase()
  if (!e) return null
  if (e === BOT_EMAIL) return 'bot'
  if (e.endsWith('@invalid.local')) return 'placeholder'
  if (e.endsWith('@nivaro.local')) return 'integration'
  if (e.split('@')[0].includes('integration')) return 'integration'
  return null
}

/** The account's kind, or null for a person. */
export function accountKindOf(user: AccountLike | null | undefined): AccountKind | null {
  if (!user) return null
  if (isAccountKind(user.account_kind)) return user.account_kind
  return accountKindFromEmail(user.email)
}

export function isMachineAccount(user: AccountLike | null | undefined): boolean {
  return accountKindOf(user) !== null
}
