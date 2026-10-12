import { describeAiProvider, getAiClient, getAiModelSettings, settingsRow } from './ai-client.js'
import { qualityFromSettings } from './ai-quality.js'
import { registerReadinessCheck } from './readiness.js'

/**
 * AI provider health (#1821): one tiny round trip to the configured provider,
 * graded reachable / slow / failing. The probe bypasses the budget and the
 * failure fallback on purpose — it must report the PRIMARY provider's state,
 * not the fallback's, and a spent budget must not make the provider look down.
 */

export type AiHealthStatus = 'reachable' | 'slow' | 'failing' | 'unconfigured'

export interface AiHealth {
  status: AiHealthStatus
  checked_at: string
  latency_ms: number | null
  model: string | null
  provider: string
  detail: string
  fallback_model: string | null
}

export const SLOW_MS = 5000

export function gradeProbe(ok: boolean, ms: number): { status: AiHealthStatus; detail: string } {
  if (!ok) return { status: 'failing', detail: 'The provider did not answer the probe.' }
  if (ms >= SLOW_MS)
    return {
      status: 'slow',
      detail: `Answered in ${(ms / 1000).toFixed(1)}s — over the ${SLOW_MS / 1000}s mark.`
    }
  return { status: 'reachable', detail: `Answered in ${ms} ms.` }
}

let last: AiHealth | null = null
let inflight: Promise<AiHealth> | null = null

export function lastAiHealth(): AiHealth | null {
  return last
}

export async function probeAiProvider(opts?: { maxAgeMs?: number }): Promise<AiHealth> {
  const maxAge = opts?.maxAgeMs ?? 0
  if (last && maxAge > 0 && Date.now() - new Date(last.checked_at).getTime() < maxAge) return last
  if (inflight) return inflight
  inflight = (async () => {
    const info = await describeAiProvider()
    const quality = qualityFromSettings(await settingsRow())
    const base = {
      checked_at: new Date().toISOString(),
      model: info.model ?? null,
      provider: info.provider,
      fallback_model: quality.fallback_model
    }
    if (!info.configured) {
      last = {
        ...base,
        status: 'unconfigured' as const,
        latency_ms: null,
        detail: info.reason ?? 'AI is not configured.'
      }
      return last
    }
    const t0 = Date.now()
    let ok = false
    let err = ''
    try {
      const client = await getAiClient({ guard: false, fallback: false })
      if (!client) throw new Error('no client')
      const { model } = await getAiModelSettings()
      await client.messages.create({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }]
      })
      ok = true
    } catch (e) {
      err = String((e as Error)?.message ?? e).slice(0, 200)
    }
    const ms = Date.now() - t0
    const g = gradeProbe(ok, ms)
    last = {
      ...base,
      status: g.status,
      latency_ms: ok ? ms : null,
      detail: ok ? g.detail : `${g.detail} ${err}`.trim()
    }
    return last
  })().finally(() => {
    inflight = null
  })
  return inflight
}

let registered = false
export function registerAiHealthReadiness(): void {
  if (registered) return
  registered = true
  registerReadinessCheck({
    id: 'ai-provider',
    label: 'AI provider answers',
    group: 'Operations',
    description:
      'Sends one tiny request to the configured AI provider and reports reachable, slow (over 5 seconds) or failing. Cached for five minutes so the scorecard does not spend on every load. With a fallback model set, AI features switch to it when calls fail.',
    run: async () => {
      const h = await probeAiProvider({ maxAgeMs: 300_000 })
      if (h.status === 'unconfigured') return { status: 'skip', detail: h.detail }
      if (h.status === 'reachable') return { status: 'pass', detail: h.detail }
      return {
        status: h.status === 'slow' ? 'warn' : 'fail',
        detail: h.detail,
        blockers: h.fallback_model
          ? [`Calls will switch to the fallback model (${h.fallback_model}) when they fail.`]
          : ['No fallback model is set: AI features will show "AI is unavailable".']
      }
    }
  })
}
