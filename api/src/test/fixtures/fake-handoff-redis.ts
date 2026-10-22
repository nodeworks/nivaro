/**
 * An in-memory stand-in for the few Redis commands the media hand-off, the
 * caption job store and the worker heartbeat use: lists, hashes, get/set/del,
 * a pub/sub whose duplicate() connections hear what publish() sends, and the
 * hand-off's one EVAL script (ENQUEUE_LUA), emulated step for step. The Lua
 * itself is checked against a real Redis by hand (see media-handoff.ts).
 */
export function fakeHandoffRedis() {
  const lists = new Map<string, string[]>()
  const kv = new Map<string, string>()
  const hashes = new Map<string, Map<string, string>>()
  const hash = (k: string) => {
    let h = hashes.get(k)
    if (!h) {
      h = new Map()
      hashes.set(k, h)
    }
    return h
  }
  const subscribers: Array<{ channels: Set<string>; fn: ((c: string, m: string) => void) | null }> =
    []
  const published: Array<{ channel: string; message: string }> = []
  const r = {
    lists,
    kv,
    hashes,
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
    async hget(key: string, field: string) {
      return hashes.get(key)?.get(field) ?? null
    },
    async hdel(key: string, field: string) {
      return hashes.get(key)?.delete(field) ? 1 : 0
    },
    async hgetall(key: string) {
      return Object.fromEntries(hashes.get(key) ?? [])
    },
    /** ENQUEUE_LUA: KEYS list, records; ARGV max, item, record id, record, user, per-user max. */
    async eval(_script: string, _n: number, ...a: Array<string | number>) {
      const [list, recs, max, item, recId, record, user, perUser] = a.map(String)
      if ((lists.get(list)?.length ?? 0) >= Number(max)) return -1
      if (recId !== '') {
        let n = 0
        for (const v of hash(recs).values()) {
          try {
            if (JSON.parse(v).user === user) n++
          } catch {
            /* like pcall(cjson.decode) */
          }
        }
        if (n >= Number(perUser)) return -2
        hash(recs).set(recId, record)
      }
      return r.rpush(list, item)
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
