import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { awsProvider } from '../../../services/hub/providers/aws/adapter.js'
import { makeProviderContext } from '../../../services/hub/providers/context.js'
import type {
  DesiredResource,
  Observed,
  ProviderContext
} from '../../../services/hub/providers/types.js'

/**
 * Test harness for the AWS adapter: answers from recorded fixtures (`aws/__fixtures__`), keyed
 * by `<service>:<Action>` for the Query / JSON APIs and `<service>:<METHOD> <path>` for REST
 * (Route 53, S3). A handler is a fixture name, `{status, file|body}`, a function of the call, or
 * an array answered in order (the last entry repeats). Every call is recorded.
 */

const DIR = join(import.meta.dirname, '../../../services/hub/providers/aws/__fixtures__')
export const fixture = (name: string) => readFileSync(join(DIR, name), 'utf8')

export interface Call {
  service: string
  action: string
  params: Record<string, string>
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body: string
}

type Answer =
  | string
  | { status?: number; file?: string; body?: string; headers?: Record<string, string> }
type Handler = Answer | ((call: Call) => Answer) | Answer[]

const PREFIX: Record<string, string> = {
  ec2: 'ec2',
  rds: 'rds',
  elasticloadbalancing: 'elbv2',
  sts: 'sts',
  acm: 'acm',
  s3: 's3',
  route53: 'route53'
}

export const CONFIG = {
  account_id: '123456789012',
  regions: ['us-east-1', 'eu-west-1'],
  access_key_id: 'AKIAFAKEFAKEFAKE0001'
}
export const SECRETS = { secret_access_key: 'test-secret-access-key-0001' }

export function harness(
  handlers: Record<string, Handler>,
  over: {
    config?: Record<string, unknown>
    secrets?: Record<string, string>
    region?: string | null
  } = {}
) {
  const calls: Call[] = []
  const counters = new Map<string, number>()
  const fetchImpl = async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: unknown }
  ) => {
    const u = new URL(url)
    const service = PREFIX[u.hostname.split('.')[0]] ?? u.hostname
    const body = typeof init.body === 'string' ? init.body : ''
    const headers = (init.headers ?? {}) as Record<string, string>
    const params = Object.fromEntries(new URLSearchParams(body))
    let action = params.Action ?? ''
    if (service === 'acm')
      action =
        String(headers['x-amz-target'] ?? '')
          .split('.')
          .pop() ?? ''
    const method = (init.method ?? 'GET').toUpperCase()
    const call: Call = {
      service,
      action,
      params,
      method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers,
      body
    }
    calls.push(call)
    const keys = action
      ? [`${service}:${action}`]
      : [`${service}:${method} ${u.pathname}${u.search}`, `${service}:${method} ${u.pathname}`]
    const key = keys.find((k) => k in handlers)
    if (!key) throw new Error(`No fixture handler for ${keys[0]}`)
    let h = handlers[key]
    if (Array.isArray(h)) {
      const n = counters.get(key) ?? 0
      counters.set(key, n + 1)
      h = h[Math.min(n, h.length - 1)]
    }
    const ans = typeof h === 'function' ? h(call) : h
    const a = typeof ans === 'string' ? { file: ans } : ans
    const text = a.body ?? (a.file ? fixture(a.file) : '')
    return new Response(text, { status: a.status ?? 200, headers: a.headers })
  }
  const ctx = makeProviderContext({
    adapter: awsProvider,
    connectionId: 7,
    config: { ...CONFIG, ...over.config },
    secrets: { ...SECRETS, ...over.secrets },
    region: over.region === undefined ? 'us-east-1' : over.region,
    now: () => new Date('2026-11-26T12:00:00Z'),
    fetch: { fetchImpl: fetchImpl as never }
  }) as ProviderContext
  return { ctx, calls, of: (action: string) => calls.filter((c) => c.action === action) }
}

export function desired(
  type: string,
  fields: Record<string, unknown>,
  extra: Partial<DesiredResource> = {}
): DesiredResource {
  return {
    resourceId: 41,
    type,
    externalId: null,
    scope: 'app',
    appId: 1,
    environmentId: 2,
    fields: { region: 'us-east-1', ...fields },
    refs: {},
    tags: { 'nivaro-hub:app': 'shop', 'nivaro-hub:env': 'production', 'nivaro-hub:resource': '41' },
    ...extra
  }
}

export const observedOf = (
  o: Partial<Observed> & Pick<Observed, 'type' | 'externalId'>
): Observed => ({
  name: null,
  fields: { region: 'us-east-1' },
  tags: {},
  ...o
})
