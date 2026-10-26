import type { FastifyRequest } from 'fastify'
import { MCP_INNER_HEADER } from './mcp-config.js'

/** The caller's own credential for an in-process call made on their behalf. */
export function callerHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json' }
  for (const h of ['authorization', 'cookie', 'x-workspace', 'user-agent', MCP_INNER_HEADER]) {
    const v = req.headers[h]
    if (typeof v === 'string') out[h] = v
  }
  return out
}

export interface CallerResponse {
  statusCode: number
  body: string
  json: () => unknown
}

/**
 * An in-process API call made AS the request's caller (their own session or
 * key — every permission, scope, hook and log applies), for item actions that
 * run a step on someone's behalf. The extension never sees the credential.
 */
export function callAsCallerFor(
  req: FastifyRequest
): (opts: { method: string; url: string; payload?: unknown }) => Promise<CallerResponse> {
  return async ({ method, url, payload }) => {
    if (!url.startsWith('/api/')) throw new Error('callAsCaller only reaches /api/ routes')
    const res = await req.server.inject({
      method: method.toUpperCase() as 'GET',
      url,
      headers: callerHeaders(req),
      ...(payload === undefined
        ? {}
        : { payload: typeof payload === 'string' ? payload : JSON.stringify(payload) })
    })
    return {
      statusCode: res.statusCode,
      body: res.body,
      json: () => JSON.parse(res.body || 'null')
    }
  }
}
