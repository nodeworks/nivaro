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
