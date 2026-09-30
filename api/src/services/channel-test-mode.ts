/**
 * Test mode for web push and Teams (#832) — the same contract as mail and SMS
 * test mode: in dev and staging nobody outside an allowlist is reached.
 *
 *   push   a push to a person whose email is not allowlisted goes to the test
 *          recipient's browsers instead, titled "[TEST — was: <email>] …";
 *          with no test recipient it is dropped (server log).
 *   Teams  a card goes to the test channel's webhook instead, titled
 *          "[TEST — was: <channel host>] …"; with no test webhook it is dropped.
 *
 * MODE: env (PUSH_TEST_MODE / TEAMS_TEST_MODE) OR the settings switch — env
 * wins so a production-database restore into staging never switches it off.
 * RECIPIENT: the source that turned the mode on supplies it (settings on →
 * the settings field, empty means drop; settings off → the env value).
 */
import { db } from '../db/index.js'
import { overlaySettings } from './settings-overrides.js'

export interface ChannelTestConfig {
  push: { on: boolean; recipient: string | null; allowlist: string[] }
  teams: { on: boolean; webhook: string | null }
}

const envOn = (v: string | undefined) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim())
const bit = (v: unknown) => v === true || v === 1 || v === '1'

let cache: { at: number; value: ChannelTestConfig } | null = null

export function bustChannelTestMode(): void {
  cache = null
}

export function channelTestConfigFrom(row: Record<string, unknown> | undefined): ChannelTestConfig {
  const pushDb = bit(row?.push_test_mode)
  const teamsDb = bit(row?.teams_test_mode)
  const pushRecipient = String(row?.push_test_recipient ?? '').trim()
  const teamsWebhook = String(row?.teams_test_webhook_url ?? '').trim()
  return {
    push: {
      on: envOn(process.env.PUSH_TEST_MODE) || pushDb,
      recipient: pushDb
        ? pushRecipient || null
        : pushRecipient || process.env.PUSH_TEST_RECIPIENT?.trim() || null,
      allowlist: String(row?.push_test_allowlist ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    },
    teams: {
      on: envOn(process.env.TEAMS_TEST_MODE) || teamsDb,
      webhook: teamsDb
        ? teamsWebhook || null
        : teamsWebhook || process.env.TEAMS_TEST_WEBHOOK_URL?.trim() || null
    }
  }
}

export async function getChannelTestConfig(): Promise<ChannelTestConfig> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value
  let row: Record<string, unknown> | undefined
  try {
    row = await overlaySettings(
      (await db('nivaro_settings').orderBy('id', 'asc').first()) as Record<string, unknown> | undefined
    )
  } catch {
    row = undefined
  }
  const value = channelTestConfigFrom(row)
  cache = { at: Date.now(), value }
  return value
}

export function isAllowlisted(email: string, allowlist: string[]): boolean {
  const e = email.trim().toLowerCase()
  return allowlist.some((a) => (a.startsWith('@') ? e.endsWith(a) : e === a))
}

/** Pure: where a push goes. `null` = dropped. */
export function routePushDecision(
  cfg: ChannelTestConfig['push'],
  email: string | null
): { redirectTo: string | null; prefix: string | null } | null {
  if (!cfg.on) return { redirectTo: null, prefix: null }
  if (email && isAllowlisted(email, cfg.allowlist)) return { redirectTo: null, prefix: null }
  if (!cfg.recipient) return null
  if (email && email.toLowerCase() === cfg.recipient.toLowerCase()) return { redirectTo: null, prefix: null }
  return { redirectTo: cfg.recipient, prefix: `[TEST — was: ${email ?? 'unknown'}] ` }
}

/** Resolve a push for `userId` under test mode: the user to send to and the title prefix. */
export async function routePush(
  userId: string
): Promise<{ userId: string; prefix: string } | null> {
  const cfg = (await getChannelTestConfig()).push
  if (!cfg.on) return { userId, prefix: '' }
  const user = (await db('nivaro_users').where({ id: userId }).first('email').catch(() => null)) as
    | { email?: string | null }
    | null
  const decision = routePushDecision(cfg, user?.email ?? null)
  if (!decision) {
    console.warn('[push] test mode: dropped push to', user?.email ?? userId, '(no test recipient)')
    return null
  }
  if (!decision.redirectTo) return { userId, prefix: '' }
  const target = (await db('nivaro_users')
    .whereRaw('LOWER(email) = ?', [decision.redirectTo.toLowerCase()])
    .first('id')
    .catch(() => null)) as { id?: string } | null
  if (!target?.id) {
    console.warn('[push] test mode: test recipient', decision.redirectTo, 'is not a user — dropped')
    return null
  }
  return { userId: String(target.id), prefix: decision.prefix ?? '' }
}

/** Resolve a Teams card under test mode: the webhook and the title prefix. `null` = dropped. */
export async function routeTeams(url: string): Promise<{ url: string; prefix: string } | null> {
  const cfg = (await getChannelTestConfig()).teams
  return routeTeamsDecision(cfg, url)
}

export function routeTeamsDecision(
  cfg: ChannelTestConfig['teams'],
  url: string
): { url: string; prefix: string } | null {
  if (!cfg.on) return { url, prefix: '' }
  if (!cfg.webhook) {
    console.warn('[teams] test mode: dropped a card (no test webhook configured)')
    return null
  }
  if (cfg.webhook === url) return { url, prefix: '' }
  let host = 'channel'
  try {
    host = new URL(url).host
  } catch {}
  return { url: cfg.webhook, prefix: `[TEST — was: ${host}] ` }
}
