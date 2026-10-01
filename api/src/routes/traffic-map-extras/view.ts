// api/src/routes/traffic-map-extras/view.ts
import type { FastifyInstance } from 'fastify'
import { getAiClient, getAiModelSettings } from '../../services/ai-client.js'
import { getIo } from '../../services/io-holder.js'
import { correlate, POINTS, TOP_N } from '../../services/traffic-correlation.js'
import { entityRequestSeries } from '../../services/traffic-map.js'
import { attachTrafficPresence } from '../../services/traffic-map-presence.js'
import {
  cleanPrompt,
  cleanVocabulary,
  NL_TOOL,
  systemPrompt,
  validateNlFilter
} from '../../services/traffic-nl-filter.js'
// Taps for the whole-map workspace scope (#1154) and app grouping (#1163) register at boot.
import '../../services/traffic-taps/workspace-scope.js'
import '../../services/traffic-taps/caller-apps.js'

/**
 * Canvas & view (group D):
 *  - GET  /correlations — #1149 entities that rise together over the window (busiest TOP_N only).
 *  - POST /nl-filter    — #1133 prose → the map's own filters (one forced tool call).
 *  - #1164 presence in the watch room (socket events, attached once the socket server exists).
 */
const WINDOWS = new Set([60, 300, 900])
const CACHE_MS = 3000
let corrCache: { at: number; win: number; value: unknown } | null = null

export async function trafficViewRoutes(app: FastifyInstance): Promise<void> {
  let attached = false
  app.addHook('onReady', async () => {
    const io = getIo()
    if (io && !attached) {
      attached = true
      attachTrafficPresence(io)
    }
  })

  app.get('/correlations', async (req) => {
    const w = Number((req.query as { window?: string }).window)
    const win = WINDOWS.has(w) ? w : 900
    if (corrCache && corrCache.win === win && Date.now() - corrCache.at < CACHE_MS)
      return { data: corrCache.value }
    // 5-second buckets at 15 minutes; the shorter windows keep at least 12 buckets
    const points = Math.max(12, Math.round((POINTS * win) / 900))
    const rows = entityRequestSeries(win, points, TOP_N)
    const value = { window_s: win, compared: rows.length, pairs: correlate(rows) }
    corrCache = { at: Date.now(), win, value }
    return { data: value }
  })

  app.post('/nl-filter', async (req, reply) => {
    const body = (req.body ?? {}) as { prompt?: unknown; vocabulary?: unknown }
    const prompt = cleanPrompt(body.prompt)
    if (!prompt) return reply.code(400).send({ error: 'Type what you want to see first' })
    const client = await getAiClient()
    if (!client)
      return reply.code(503).send({
        error: 'No AI provider is set up. An administrator can add one in Settings → AI Features.',
        code: 'AI_NOT_CONFIGURED'
      })
    const vocab = cleanVocabulary(body.vocabulary)
    const { model } = await getAiModelSettings()
    try {
      const res = await client.messages.create({
        model,
        max_tokens: 400,
        system: systemPrompt(vocab),
        tools: [NL_TOOL as never],
        tool_choice: { type: 'tool', name: NL_TOOL.name },
        messages: [{ role: 'user', content: prompt }]
      })
      const use = res.content.find((b) => b.type === 'tool_use') as { input?: unknown } | undefined
      if (!use) return reply.code(502).send({ error: 'The AI did not return filters. Try again.' })
      return { data: validateNlFilter(use.input, vocab) }
    } catch (err) {
      req.log.warn({ err }, 'traffic nl-filter failed')
      return reply.code(502).send({ error: 'The AI call failed. Try again in a moment.' })
    }
  })
}
