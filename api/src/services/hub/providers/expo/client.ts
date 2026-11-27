import { ProviderFetchError } from '../provider-fetch.js'
import { isRetryableStatus, type ProviderContext, ProviderError } from '../types.js'

export const EAS_ENDPOINT = 'https://api.expo.dev/graphql'

interface GqlBody {
  data?: unknown
  errors?: Array<{ message?: string; extensions?: { errorCode?: string; code?: string } }>
}

/** One GraphQL call. HTTP failures and GraphQL `errors` (even with HTTP 200) become ProviderError. */
export async function gql<T = Record<string, any>>(
  ctx: ProviderContext,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const token = ctx.secrets.token
  if (!token) throw new ProviderError('EXPO_NO_TOKEN', 'The connection has no access token.')
  let res: Response
  try {
    res = await ctx.fetch(EAS_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify({ query, variables })
    })
  } catch (err) {
    if (err instanceof ProviderFetchError)
      throw new ProviderError(`EXPO_${err.code}`, ctx.scrub(err.message), {
        retryable: err.retryable
      })
    throw new ProviderError('EXPO_NETWORK', 'Could not reach Expo.', { retryable: true })
  }
  const text = await res.text().catch(() => '')
  let body: GqlBody = {}
  try {
    body = text ? (JSON.parse(text) as GqlBody) : {}
  } catch {
    body = {}
  }
  const first = body.errors?.[0]
  const detail = first?.message ? ctx.scrub(first.message) : ''
  if (!res.ok) {
    const code =
      res.status === 401 || res.status === 403
        ? 'AUTH_FAILED'
        : res.status === 429
          ? 'EXPO_RATE_LIMITED'
          : 'EXPO_HTTP'
    throw new ProviderError(code, detail || `Expo answered ${res.status}.`, {
      retryable: isRetryableStatus(res.status),
      status: res.status
    })
  }
  if (body.errors?.length) {
    const errorCode = first?.extensions?.errorCode ?? first?.extensions?.code ?? ''
    const rate = /RATE_LIMIT/i.test(errorCode) || /rate limit/i.test(detail)
    throw new ProviderError(
      rate ? 'EXPO_RATE_LIMITED' : /NOT_FOUND/i.test(errorCode) ? 'EXPO_NOT_FOUND' : 'EXPO_GRAPHQL',
      detail || 'Expo refused the request.',
      { retryable: rate, status: res.status }
    )
  }
  return (body.data ?? {}) as T
}

/** True when the provider says the thing is not there (observe answers null). */
export function isGone(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false
  if (err.code === 'EXPO_NOT_FOUND') return true
  return err.code === 'EXPO_GRAPHQL' && /not found|does not exist|no such/i.test(err.message)
}

/** Branch / channel / env var / build ids carry their app: `<appId>:<entityId>`. */
export function composeId(appId: string, id: string): string {
  return `${appId}:${id}`
}

export function splitId(externalId: string): { appId: string; id: string } {
  const i = externalId.indexOf(':')
  if (i < 0) throw new ProviderError('EXPO_BAD_ID', 'Not an Expo resource id (expected app:id).')
  return { appId: externalId.slice(0, i), id: externalId.slice(i + 1) }
}

/** Walks an offset/limit list to its end (capped). */
export async function pageAll<T>(
  fetchPage: (offset: number, limit: number) => Promise<T[]>,
  limit = 100,
  maxPages = 20
): Promise<T[]> {
  const out: T[] = []
  for (let p = 0; p < maxPages; p++) {
    const items = await fetchPage(p * limit, limit)
    out.push(...items)
    if (items.length < limit) break
  }
  return out
}
