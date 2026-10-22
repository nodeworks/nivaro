/**
 * An in-memory stand-in for the few Redis commands the media hand-off, the
 * caption job store and the worker heartbeat use: lists, get/set/del and a
 * pub/sub whose duplicate() connections hear what publish() sends.
 */
export function fakeHandoffRedis() {
  const lists = new Map<string, string[]>()
  const kv = new Map<string, string>()
  const subscribers: Array<{ channels: Set<string>; fn: ((c: string, m: string) => void) | null }> =
    []
  const published: Array<{ channel: string; message: string }> = []
  const r = {
    lists,
    kv,
    published,
    async rpush(key: string, value: string) {
      const l = lists.get(key) ?? []
      l.push(value)
      lists.set(key, l)
      return l.length
    },
    async lpop(key: string) {
      return lists.get(key)?.shift() ?? null
    },
    async llen(key: string) {
      return lists.get(key)?.length ?? 0
    },
    async publish(channel: string, message: string) {
      published.push({ channel, message })
      for (const s of subscribers) if (s.channels.has(channel)) s.fn?.(channel, message)
      return 1
    },
    async set(key: string, value: string) {
      kv.set(key, value)
      return 'OK'
    },
    async get(key: string) {
      return kv.get(key) ?? null
    },
    async del(key: string) {
      return kv.delete(key) ? 1 : 0
    },
    duplicate() {
      const s = { channels: new Set<string>(), fn: null as ((c: string, m: string) => void) | null }
      subscribers.push(s)
      return {
        on(e: string, fn: (c: string, m: string) => void) {
          if (e === 'message') s.fn = fn
        },
        async subscribe(c: string) {
          s.channels.add(c)
        },
        async quit() {
          s.channels.clear()
        }
      }
    }
  }
  return r
}
