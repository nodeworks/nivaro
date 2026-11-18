/**
 * Is a source (issue log, support tickets, records) switched on for a connection? Missing
 * settings = on. Pure, in its own module so every tracker file (and its test mocks of
 * connections.ts) can use it.
 */
export function sourceOn(
  conn:
    | { sync?: { sources?: Partial<Record<'issue' | 'ticket' | 'record', boolean>> } | null }
    | null
    | undefined,
  kind: 'issue' | 'ticket' | 'record'
): boolean {
  return conn?.sync?.sources?.[kind] !== false
}

/** `nivaro_issues.source` of an issue brought in from GitLab (import.ts). */
export const IMPORTED_SOURCE = 'gitlab'

/**
 * Issues GitLab sync wrote itself — its own warnings ('tracker') and issues brought in from
 * GitLab ('gitlab'): never evaluated by the rules, never sent to GitLab as a new issue.
 */
export function isSyncOwnSource(source: unknown): boolean {
  return source === 'tracker' || source === IMPORTED_SOURCE
}

/**
 * A GitLab issue a person wrote — linked by hand ('linked') or brought in from GitLab
 * ('imported'): gets comments and example notes only, unless `push_to_linked` is on.
 */
export function personWritten(createdVia: unknown): boolean {
  return createdVia === 'linked' || createdVia === 'imported'
}
