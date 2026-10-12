/**
 * The tool steps of a streamed Ask AI answer (#1839), as plain lines above
 * the answer: "Reading workflows… 42 found". The server sends `ai:status`
 * once when a tool starts and again with `done: true` (+ a short `result`,
 * or `failed: true`) when it returns; (round, step) pairs the two. Older
 * servers send only the start — every step then just reads as started.
 */

export interface AiStreamStep {
  key: string
  round: number
  text: string
  tool?: string
  state: 'running' | 'done' | 'failed'
  result?: string
}

export function applyStepStatus(
  steps: AiStreamStep[],
  payload: Record<string, unknown>
): AiStreamStep[] {
  const text = String(payload.text ?? '')
  if (!text) return steps
  const round = Number(payload.round ?? 0)
  const idx = payload.step == null ? null : Number(payload.step)
  const key = idx == null ? `${round}:${steps.length}:${text}` : `${round}:${idx}`
  const tool = typeof payload.tool === 'string' && payload.tool ? payload.tool : undefined
  const done = payload.done === true
  const failed = payload.failed === true
  const at = steps.findIndex((s) => s.key === key)
  if (at < 0) {
    // A server without step indexes: a new start ends the previous step.
    const prev =
      idx == null
        ? steps.map((s) => (s.state === 'running' ? { ...s, state: 'done' as const } : s))
        : steps
    return [
      ...prev,
      {
        key,
        round,
        text,
        tool,
        state: failed ? 'failed' : done ? 'done' : 'running',
        result: done && payload.result ? String(payload.result) : undefined
      }
    ]
  }
  if (!done && !failed) return steps
  const next = steps.slice()
  next[at] = {
    ...next[at],
    state: failed ? 'failed' : 'done',
    result: payload.result ? String(payload.result) : next[at].result
  }
  return next
}
