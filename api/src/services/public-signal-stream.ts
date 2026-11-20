import type { FastifyReply, FastifyRequest } from 'fastify'
import { markEndlessStream } from '../lib/drain-streams.js'
import { type SseEvent, sseEventForTenant, subscribeSse } from './sse-hub.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Token-scoped "changed" streams for public pages (embedded widget feeds, record share links).
 *
 * A public page has no viewer to check permissions against: it is served AS ITS CREATOR through
 * its own route. Its live stream must therefore never say more than a reload of that route
 * would. So the stream carries one bare `changed` event — no ids, no field names, no values —
 * and only when the page's own answer actually changed: a write on a watched collection merely
 * PROMPTS a recompute of the page's fingerprint (shared per token for a moment, and drawn from
 * the pushed-widget recompute budget, WIDGET_LIVE_MAX_PER_MIN); the page then refetches through
 * its own route.
 *
 * Limits: a per-route cap of open streams per address, one recompute per token per burst
 * (coalesced), a heartbeat that re-checks the token still serves (`gone` + close when not), a
 * slow reader past 64 KB unwritten just misses signals. Streams close in preClose.
 */

/** A fingerprint recompute that was over budget: the stream asks again a little later. */
export const BUSY = '\u0000busy'

export interface SignalStreamSubject {
  /** Does this record change concern the page? (Collection / record match, tenant already checked.) */
  watches(ev: SseEvent): boolean
  /** Fingerprint of what the page serves now; null = can't tell (no signal); BUSY = over budget. */
  signature(): Promise<string | null>
  /** Still serving? Checked every heartbeat. */
  stillServes(): Promise<boolean>
}

export interface SignalStreamOptions {
  perIp: number
  heartbeatMs: number
  coalesceMs: number
  /** Retry delay when a recompute was over budget (BUSY). */
  busyRetryMs?: number
  /** Open the subject; a refusal answers with this status + body. */
  open(): Promise<
    { ok: true; subject: SignalStreamSubject } | { ok: false; code: number; body: unknown }
  >
}

/** Per-route state: the address counter and the open streams (closed on shutdown). */
export class SignalStreamRoute {
  private readonly byIp = new Map<string, number>()
  private readonly open = new Set<() => void>()

  /** Close every open stream (Fastify preClose). */
  closeAll(): void {
    for (const end of [...this.open]) end()
  }

  openCount(): number {
    return this.open.size
  }

  async serve(req: FastifyRequest, reply: FastifyReply, opts: SignalStreamOptions): Promise<void> {
    const ip = req.ip || 'unknown'
    // Reserve the slot before any await so concurrent opens can't overrun the cap; every exit
    // gives it back exactly once.
    if ((this.byIp.get(ip) ?? 0) >= opts.perIp) {
      return void reply
        .code(429)
        .header('Retry-After', '60')
        .send({ error: 'Too many live streams from this address' })
    }
    this.byIp.set(ip, (this.byIp.get(ip) ?? 0) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      const n = (this.byIp.get(ip) ?? 1) - 1
      if (n > 0) this.byIp.set(ip, n)
      else this.byIp.delete(ip)
    }
    let gone = false
    req.raw.once('close', () => {
      gone = true
      release()
    })

    let subject: SignalStreamSubject
    let lastSig: string | null
    try {
      const opened = await opts.open()
      if (!opened.ok) {
        release()
        return void reply.code(opened.code).send(opened.body)
      }
      subject = opened.subject
      const first = await subject.signature()
      lastSig = first === BUSY ? null : first
    } catch {
      release()
      return void reply.code(503).send({ error: 'Unavailable' })
    }
    if (gone || req.raw.destroyed) {
      release()
      return
    }
    const tenant = currentTenantKey()

    reply.hijack()
    const raw = reply.raw
    // A shutdown ends this subscription at once; real requests finish (lib/drain-streams.ts).
    markEndlessStream(raw)
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': '*'
    })
    raw.write('retry: 5000\n: connected\n\n')

    let closed = false
    let pending: ReturnType<typeof setTimeout> | null = null
    const send = (frame: string) => {
      if (closed) return
      if ((raw.writableLength ?? 0) > 64 * 1024) return
      try {
        raw.write(frame)
      } catch {
        end()
      }
    }
    const check = (delay: number) => {
      pending = setTimeout(() => {
        if (closed) return
        void subject.signature().then((sig) => {
          if (closed) return
          if (sig === BUSY) {
            check(opts.busyRetryMs ?? 10_000)
            return
          }
          pending = null
          if (sig === null || sig === lastSig) return
          lastSig = sig
          send('event: changed\ndata: {}\n\n')
        })
      }, delay)
    }
    const unsubscribe = subscribeSse((ev: SseEvent) => {
      if (closed || pending) return
      if (!sseEventForTenant(ev, tenant)) return
      if (!subject.watches(ev)) return
      check(opts.coalesceMs)
    })
    const heartbeat = setInterval(() => {
      void subject
        .stillServes()
        .then((still) => {
          if (closed) return
          if (still) send(': hb\n\n')
          else {
            send('event: gone\ndata: {}\n\n')
            end()
          }
        })
        .catch(() => send(': hb\n\n'))
    }, opts.heartbeatMs)
    heartbeat.unref()

    const end = (): void => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      if (pending) clearTimeout(pending)
      unsubscribe()
      this.open.delete(end)
      release()
      try {
        raw.end()
      } catch {
        /* already gone */
      }
    }
    this.open.add(end)
    req.raw.on('close', end)
  }
}

/**
 * A short-lived per-key memo so many open streams of one token share one recompute. A miss
 * spends one unit of `budget` (when given); over budget answers BUSY and memoizes nothing.
 */
export function sharedSignature(
  memo: Map<string, { at: number; sig: Promise<string | null> }>,
  key: string,
  compute: () => Promise<string | null>,
  opts: { ttlMs?: number; budget?: () => boolean } = {}
): Promise<string | null> {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < (opts.ttlMs ?? 1_500)) return hit.sig
  if (opts.budget && !opts.budget()) return Promise.resolve(BUSY)
  const sig = compute().catch(() => null)
  memo.set(key, { at: Date.now(), sig })
  if (memo.size > 2_000) memo.delete(memo.keys().next().value as string)
  return sig
}
