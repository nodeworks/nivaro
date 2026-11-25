import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from '../db/index.js'
import { failedAuthLimiter, windowLimiter } from '../lib/auth-fail-limiter.js'
import {
  HUB_ACCENT,
  HUB_PRODUCT_NAME,
  isStockProjectName,
  NIVARO_STOCK_ACCENT
} from '../services/hub/brand.js'
import {
  hashToken,
  pageForToken,
  type StatusAnswer,
  statusAnswer,
  statusPageGoneHtml,
  statusPageHtml
} from '../services/hub/incident/status-page.js'
import { STATUS_PAGES } from '../services/hub/incident/store.js'
import { hubModeEnabled } from '../services/hub/mode.js'

/**
 * The PUBLIC Hub status page (Hub enhancement 34) — the one Hub route with no sign-in, in its own
 * plugin on purpose: it carries neither requireAuth nor requireAdmin (so the Hub credential gate
 * has nothing to swap) and the catalog lists it as `public`. Mounted at /api/hub/status-page only
 * with HUB=on (never in cloud mode: hub mode is refused there).
 *
 *   GET /api/hub/status-page/:token              the page (server-rendered HTML, no script)
 *   GET /api/hub/status-page/:token?format=json  the same answer as JSON
 *
 * The token is the whole credential: only its SHA-256 is stored, it expires, a rotation replaces
 * it. A wrong, expired or revoked token gets the same 404 page (no oracle). What the page says is
 * statusAnswer (no hostnames, versions, error text, people or environment keys).
 *
 * Abuse: per address 60 reads a minute and 20 unknown tokens a minute (then 429), per page 600
 * reads a minute; one answer per page is built at most every CACHE_MS and shared. GET only (the
 * maintenance freeze never stops it). `Cache-Control: no-store`, `noindex`, no referrer, a CSP
 * that allows nothing but inline styles and the Hub favicon.
 */

export const CACHE_MS = 15_000
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

function secure(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store')
  reply.header('Content-Security-Policy', CSP)
  reply.header('X-Robots-Tag', 'noindex, nofollow')
  reply.header('Referrer-Policy', 'no-referrer')
  reply.header('X-Content-Type-Options', 'nosniff')
}

/** The operator's name and colour (white-label first), else the Hub's own (brand.ts rules). */
async function brand(): Promise<{ name: string; accent: string }> {
  try {
    const row = (await db('nivaro_settings')
      .where({ id: 1 })
      .first('project_name', 'project_color')) as
      | { project_name?: string | null; project_color?: string | null }
      | undefined
    const name = String(row?.project_name ?? '').trim()
    const color = String(row?.project_color ?? '').trim()
    return {
      name: isStockProjectName(name) ? HUB_PRODUCT_NAME : name.slice(0, 80),
      accent:
        /^#[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== NIVARO_STOCK_ACCENT
          ? color
          : HUB_ACCENT
    }
  } catch {
    return { name: HUB_PRODUCT_NAME, accent: HUB_ACCENT }
  }
}

export async function hubStatusPublicRoutes(app: FastifyInstance): Promise<void> {
  if (!hubModeEnabled()) return
  const perIp = windowLimiter(60)
  const perPage = windowLimiter(600)
  const badTokens = failedAuthLimiter(20)
  // Built answers per page id, shared by every reader for CACHE_MS (this plugin's own scope).
  const built = new Map<number, { at: number; answer: StatusAnswer }>()

  app.get<{ Params: { token: string }; Querystring: { format?: string } }>(
    '/:token',
    async (req, reply) => {
      secure(reply)
      const json = req.query?.format === 'json'
      const tooMany = () =>
        json
          ? reply.code(429).send({ error: 'Too many requests', code: 'RATE_LIMITED' })
          : reply
              .code(429)
              .type('text/plain; charset=utf-8')
              .send('Too many requests. Try again in a minute.')
      if (badTokens.blocked(req.ip) || !perIp.take(req.ip)) return tooMany()
      const page = await pageForToken(req.params.token).catch(() => null)
      if (!page) {
        badTokens.fail(req.ip)
        return json
          ? reply.code(404).send({ error: 'Not found', code: 'NOT_FOUND' })
          : reply.code(404).type('text/html; charset=utf-8').send(statusPageGoneHtml())
      }
      if (!perPage.take(hashToken(req.params.token))) return tooMany()
      const now = Date.now()
      let hit = built.get(page.id)
      if (!hit || now - hit.at > CACHE_MS) {
        if (built.size > 500) built.clear()
        hit = { at: now, answer: await statusAnswer(page, { now }) }
        built.set(page.id, hit)
        void db(STATUS_PAGES)
          .where({ id: page.id })
          .update({ last_viewed_at: new Date(now) })
          .catch(() => {})
      }
      if (json) return reply.send({ data: hit.answer })
      return reply.type('text/html; charset=utf-8').send(statusPageHtml(hit.answer, await brand()))
    }
  )
}
