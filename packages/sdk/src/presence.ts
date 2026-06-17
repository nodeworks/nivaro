/**
 * Nivaro Presence — frontend user tracking.
 *
 * Usage (bundled apps):
 *   import { createPresence } from '@nivaro/sdk'
 *   const presence = createPresence({ apiUrl: 'https://cms.example.com' })
 *   presence.setUser('user-id', 'jane@example.com', 'Jane Doe')
 *
 * Usage (embeddable script):
 *   <script src="https://cms.example.com/api/presence.js"
 *     data-api-url="https://cms.example.com"
 *     data-user-id="{{user.id}}"
 *     data-user-email="{{user.email}}"
 *     data-user-name="{{user.name}}"></script>
 */

export interface PresenceOptions {
  apiUrl: string
  userId?: string | null
  userEmail?: string | null
  userName?: string | null
  pingInterval?: number
}

export interface PresenceSession {
  sessionId: string
  userId: string | null
  userEmail: string | null
  userName: string | null
  pageUrl: string
  pageTitle: string | null
  referrer: string | null
  deviceType: 'desktop' | 'mobile' | 'tablet'
  screenWidth: number | null
  screenHeight: number | null
  viewportWidth: number | null
  viewportHeight: number | null
  ip: string | null
  userAgent: string | null
  firstSeen: string
  lastSeen: string
}

export interface PresenceClient {
  ping(): void
  disconnect(): void
  setUser(userId: string | null, email?: string | null, name?: string | null): void
  destroy(): void
  readonly sessionId: string
}

const STORAGE_KEY = 'nvr_presence_sid'

function generateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as Crypto & { randomUUID(): string }).randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function detectDeviceType(): 'desktop' | 'mobile' | 'tablet' {
  if (typeof navigator === 'undefined') return 'desktop'
  const ua = navigator.userAgent
  if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet'
  if (/mobile|iphone|ipod|android|blackberry/i.test(ua)) return 'mobile'
  return 'desktop'
}

export function createPresence(options: PresenceOptions): PresenceClient {
  const { pingInterval = 30_000 } = options
  const base = options.apiUrl.replace(/\/$/, '')

  let userId: string | null = options.userId ?? null
  let userEmail: string | null = options.userEmail ?? null
  let userName: string | null = options.userName ?? null

  let sessionId: string
  try {
    sessionId =
      (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) || generateId()
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, sessionId)
  } catch {
    sessionId = generateId()
  }

  function buildPayload() {
    return {
      sessionId,
      userId,
      userEmail,
      userName,
      pageUrl: typeof location !== 'undefined' ? location.href : null,
      pageTitle: typeof document !== 'undefined' ? document.title : null,
      referrer: typeof document !== 'undefined' ? document.referrer || null : null,
      deviceType: detectDeviceType(),
      screenWidth: typeof screen !== 'undefined' ? screen.width : null,
      screenHeight: typeof screen !== 'undefined' ? screen.height : null,
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : null,
      viewportHeight: typeof window !== 'undefined' ? window.innerHeight : null
    }
  }

  function sendPayload(path: string, data: unknown): void {
    const url = `${base}${path}`
    const body = JSON.stringify(data)
    try {
      if (typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
        ;(navigator as Navigator & { sendBeacon(url: string, data: Blob): boolean }).sendBeacon(
          url,
          new Blob([body], { type: 'application/json' })
        )
        return
      }
    } catch {}
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    }).catch(() => {})
  }

  function ping(): void {
    sendPayload('/api/presence/ping', buildPayload())
  }

  function disconnect(): void {
    sendPayload('/api/presence/disconnect', { sessionId })
  }

  function setUser(id: string | null, email?: string | null, name?: string | null): void {
    userId = id
    userEmail = email ?? null
    userName = name ?? null
  }

  ping()

  const timer = setInterval(ping, pingInterval)

  const visHandler = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') ping()
  }
  const popHandler = () => setTimeout(ping, 100)
  const unloadHandler = () => disconnect()

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visHandler)
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', popHandler)
    window.addEventListener('pagehide', unloadHandler)
  }

  if (typeof history !== 'undefined') {
    let lastUrl = typeof location !== 'undefined' ? location.href : ''
    const orig = history.pushState.bind(history)
    history.pushState = (...args: Parameters<typeof history.pushState>) => {
      orig(...args)
      if (typeof location !== 'undefined' && location.href !== lastUrl) {
        lastUrl = location.href
        setTimeout(ping, 100)
      }
    }
  }

  function destroy(): void {
    clearInterval(timer)
    disconnect()
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', visHandler)
    if (typeof window !== 'undefined') {
      window.removeEventListener('popstate', popHandler)
      window.removeEventListener('pagehide', unloadHandler)
    }
  }

  return { ping, disconnect, setUser, destroy, sessionId }
}
