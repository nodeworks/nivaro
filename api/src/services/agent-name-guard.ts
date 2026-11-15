/**
 * What an agent (MCP connection) may NOT be called (security review 2026-11-15). An agent's
 * name shows as text beside its writes, in presence and in notifications, so a name must never
 * pass for a person or for the system:
 *
 *   - a reserved word anywhere in it as a whole word (Administrator, System, Nivaro, Support…)
 *   - the display name ("First Last") or e-mail of an active person in the directory
 *     (case-insensitive)
 *
 * A directory lookup that fails refuses the name (fail closed).
 */
import { db } from '../db/index.js'

export const RESERVED_AGENT_WORDS = [
  'administrator',
  'administrators',
  'admin',
  'admins',
  'system',
  'nivaro',
  'support',
  'helpdesk',
  'security',
  'root',
  'superuser',
  'moderator',
  'staff',
  'official',
  'it department',
  'service desk',
  'help desk'
] as const

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** The reserved word the name uses (as a whole word), else null. Pure. */
export function reservedAgentWord(name: string): string | null {
  const n = ` ${norm(name)} `
  for (const w of RESERVED_AGENT_WORDS) if (n.includes(` ${w} `)) return w
  return null
}

export interface AgentNameDeps {
  /** True when an active person's display name or e-mail equals `name` (case-insensitive). */
  isPersonName(name: string): Promise<boolean>
}

export const defaultAgentNameDeps: AgentNameDeps = {
  async isPersonName(name) {
    const lower = name.trim().toLowerCase()
    const row = await db('nivaro_users')
      .where((q) => q.whereNull('status').orWhere('status', 'active'))
      .where((q) => q.whereNull('is_redacted').orWhere('is_redacted', false))
      .where((q) =>
        q
          .whereRaw(
            "LOWER(LTRIM(RTRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))))) = ?",
            [lower]
          )
          .orWhereRaw('LOWER(email) = ?', [lower])
      )
      .first('id')
    return !!row
  }
}

/** Why `name` (already cleaned) may not be an agent's name, else null. */
export async function agentNameRefusal(
  name: string,
  deps: AgentNameDeps = defaultAgentNameDeps
): Promise<string | null> {
  const word = reservedAgentWord(name)
  if (word)
    return `"${word}" is reserved — pick a name that is clearly an assistant's, like "Ops bot".`
  const person = await deps.isPersonName(name).catch(() => true)
  if (person)
    return 'That is the name of a person here. Pick a name that is clearly an assistant’s, like "Ops bot".'
  return null
}
