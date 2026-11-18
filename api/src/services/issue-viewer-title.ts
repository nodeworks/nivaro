/**
 * What a non-admin reads as a server issue's title (army 11 o2): the stored title is
 * "[server] GET /api/items/:collection: <driver message>", and the driver message can
 * hold SQL text, table and column names. The person gets the route only — "A server
 * error on GET /api/items/:collection" — never the message. Re-exported by routes/issues.ts.
 */
export function serverIssueTitleForViewer(title: unknown): string {
  const m = /^\s*\[server\]\s+([A-Z]{3,7})\s+(\/[^\s:]*(?::[A-Za-z_][\w-]*[^\s:]*)*)/.exec(
    String(title ?? '')
  )
  return m ? `A server error on ${m[1]} ${m[2]}` : 'A server error'
}

/** The title this reader sees for an issue row: admins the stored one, others redacted. */
export function issueTitleForViewer(
  row: { source?: unknown; title?: unknown },
  isAdmin: boolean
): string {
  if (isAdmin || row.source !== 'server') return String(row.title ?? '')
  return serverIssueTitleForViewer(row.title)
}
