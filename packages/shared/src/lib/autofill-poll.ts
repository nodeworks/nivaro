/**
 * Polls a running document-autofill proposal until it lands or fails.
 *
 * The API answers 202 while the run is still going, 200 with the proposal
 * once it has landed, and a 4xx/5xx when it failed. `onSettled` fires exactly
 * once, after `onDone` or `onError` — never on a 202, which only keeps the
 * loop (and the caller's waiting state) alive. Returns a stop function; after
 * it is called no callback fires again.
 */
export type ProposalPollAnswer = { status: number; ok: boolean; json: any }

export function pollProposal(opts: {
  fetchResult: () => Promise<ProposalPollAnswer>
  onRunning?: (documentName?: string) => void
  onDone: (data: any) => void
  onError: (message: string) => void
  onSettled: () => void
  intervalMs?: number
}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const interval = opts.intervalMs ?? 2000

  const tick = async () => {
    let answer: ProposalPollAnswer
    try {
      answer = await opts.fetchResult()
    } catch (err) {
      if (stopped) return
      opts.onError((err as Error).message)
      opts.onSettled()
      return
    }
    if (stopped) return
    if (answer.status === 202) {
      const name = answer.json?.data?.document_name
      opts.onRunning?.(name ? String(name) : undefined)
      timer = setTimeout(tick, interval)
      return
    }
    if (!answer.ok) {
      opts.onError(answer.json?.error || `Document autofill failed (${answer.status})`)
      opts.onSettled()
      return
    }
    opts.onDone(answer.json?.data)
    opts.onSettled()
  }

  void tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
