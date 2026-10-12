/**
 * One tab plays the sound (#2435). With several tabs of the app open every one of them hears
 * the same notification or chat message, so a chime used to play once per tab. Tabs tell each
 * other (BroadcastChannel) when they were last used; a sound plays only in the tab used most
 * recently. A tab that stops answering for a while is ignored, so a crashed or frozen tab
 * never takes the sound with it. Without BroadcastChannel every tab plays, as before.
 */

export interface SoundTab {
  /** When the person last used this tab (focus, click, key) — 0 = never. */
  active: number
  /** When this tab last said it is alive. */
  seen: number
}

/** Tabs not heard from for this long no longer count. */
export const TAB_ALIVE_MS = 12_000
const BEAT_MS = 5_000

/**
 * The tab that plays: among the live ones, the most recently used; ties (and tabs never used)
 * go to the lowest id so exactly one tab wins everywhere. Null when no tab is live.
 */
export function pickSoundTab(
  tabs: Map<string, SoundTab>,
  now: number,
  aliveMs = TAB_ALIVE_MS
): string | null {
  let best: string | null = null
  let bestActive = -1
  for (const [id, t] of tabs) {
    if (now - t.seen > aliveMs) continue
    if (t.active > bestActive || (t.active === bestActive && best !== null && id < best)) {
      best = id
      bestActive = t.active
    }
  }
  return best
}

const selfId = Math.random().toString(36).slice(2)
const tabs = new Map<string, SoundTab>()
let channel: BroadcastChannel | null = null
let scope = ''
let started = false
let beatTimer: ReturnType<typeof setInterval> | null = null

function selfTab(): SoundTab {
  let t = tabs.get(selfId)
  if (!t) {
    t = { active: 0, seen: Date.now() }
    tabs.set(selfId, t)
  }
  return t
}

function post(msg: { t: 'beat' | 'bye'; id: string; active: number }) {
  try {
    channel?.postMessage(msg)
  } catch {
    /* a closing channel — the next beat starts over */
  }
}

function claim() {
  const t = selfTab()
  const now = Date.now()
  t.active = now
  t.seen = now
  post({ t: 'beat', id: selfId, active: now })
}

function start() {
  if (started || typeof window === 'undefined') return
  started = true
  if (typeof BroadcastChannel === 'undefined') return
  try {
    channel = new BroadcastChannel(`nvr-sound:${scope}`)
  } catch {
    channel = null
    return
  }
  channel.onmessage = (ev) => {
    const m = ev.data as { t?: string; id?: string; active?: number } | null
    if (!m?.id || m.id === selfId) return
    if (m.t === 'bye') tabs.delete(m.id)
    else if (m.t === 'beat') tabs.set(m.id, { active: Number(m.active) || 0, seen: Date.now() })
  }
  const usedNow = () => {
    if (document.visibilityState === 'visible') claim()
  }
  if (typeof document !== 'undefined' && document.hasFocus?.()) claim()
  else selfTab()
  let lastInput = 0
  const onInput = () => {
    const now = Date.now()
    if (now - lastInput < 1000) return
    lastInput = now
    claim()
  }
  window.addEventListener('focus', usedNow)
  document.addEventListener('visibilitychange', usedNow)
  window.addEventListener('pointerdown', onInput, { passive: true })
  window.addEventListener('keydown', onInput, { passive: true })
  window.addEventListener('pagehide', () => post({ t: 'bye', id: selfId, active: 0 }))
  beatTimer = setInterval(() => {
    const t = selfTab()
    t.seen = Date.now()
    post({ t: 'beat', id: selfId, active: t.active })
  }, BEAT_MS)
  // Say hello so tabs opened earlier answer with who is the most recently used.
  post({ t: 'beat', id: selfId, active: selfTab().active })
}

/**
 * Keep sounds apart per sign-in: a "View as" tab is someone else and must not be silenced by
 * (or silence) the administrator's own tabs. Call before the first sound; same idea as the
 * socket leader's key.
 */
export function configureTabSound(nextScope: string): void {
  if (nextScope === scope) return
  scope = nextScope
  if (!started) return
  try {
    channel?.close()
  } catch {
    /* already closed */
  }
  if (beatTimer) clearInterval(beatTimer)
  beatTimer = null
  channel = null
  tabs.clear()
  started = false
  start()
}

/** Should THIS tab make the sound? True when it is the most recently used live tab. */
export function shouldPlayHere(): boolean {
  start()
  if (!channel) return true
  selfTab().seen = Date.now()
  return pickSoundTab(tabs, Date.now()) === selfId
}
