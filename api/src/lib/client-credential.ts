/**
 * Requests whose machine client credentials checked out (ruling P7-15): an app server calling the
 * Nivaro Hub with its OIDC client secret (token endpoint, ping) or its hub token (app link). The
 * anonymous per-address limiter (plugins/rate-limit.ts) counts such a request only when this was
 * never noted, so a guessed secret still spends the address's budget and many apps behind one
 * egress address never do.
 */

const accepted = new WeakSet<object>()

/** The route verified this request's client credentials. */
export function noteClientCredentialAccepted(req: object): void {
  accepted.add(req)
}

export function clientCredentialAccepted(req: object): boolean {
  return accepted.has(req)
}
