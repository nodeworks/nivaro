/**
 * A V8 CPU profile (Profiler.stop) reduced to what an operator reads first:
 * where the main thread spent its time, by function (self) and by source file
 * or package (inclusive). The full profile stays downloadable for DevTools.
 */

interface CallFrame {
  functionName: string
  url: string
  lineNumber: number
}
interface ProfileNode {
  id: number
  callFrame: CallFrame
  children?: number[]
}
export interface CpuProfile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
  startTime: number
  endTime: number
}

export interface CpuProfileSummary {
  seconds: number
  busy_ms: number
  idle_ms: number
  gc_ms: number
  self: Array<{ fn: string; where: string; ms: number }>
  files: Array<{ where: string; ms: number }>
  ours: Array<{ fn: string; where: string; ms: number }>
}

/** A frame's source as a short label: `pkg:<name>`, an app path, `node:…` or `(native)`. */
export function frameSource(url: string): string {
  const clean = url.replace(/^file:\/\//, '')
  const pkg = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(clean)
  if (pkg) return `pkg:${pkg[1]}`
  const app = /\/api\/((?:src|dist|extensions)\/.*)$/.exec(clean)
  if (app) return app[1]
  return clean || '(native)'
}

const ours = (where: string) => /^(src|dist|extensions)\//.test(where)

export function summarizeCpuProfile(profile: CpuProfile, top = 25): CpuProfileSummary {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]))
  const parent = new Map<number, number>()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const total = Math.max(1, profile.endTime - profile.startTime)
  const perSampleMs = total / 1000 / Math.max(1, profile.samples.length)

  const self = new Map<string, { fn: string; where: string; n: number }>()
  const files = new Map<string, number>()
  const mine = new Map<string, { fn: string; where: string; n: number }>()
  let idle = 0
  let gc = 0
  for (const id of profile.samples) {
    const node = nodes.get(id)
    if (!node) continue
    const fn = node.callFrame.functionName || '(anonymous)'
    if (fn === '(idle)') {
      idle++
      continue
    }
    if (fn === '(garbage collector)') gc++
    const where = frameSource(node.callFrame.url)
    const key = `${fn}\u0000${where}\u0000${node.callFrame.lineNumber}`
    const s = self.get(key) ?? { fn, where, n: 0 }
    s.n++
    self.set(key, s)
    // Inclusive: count each file / function once per sample, walking to the root.
    const seenFile = new Set<string>()
    const seenFn = new Set<string>()
    let cur: number | undefined = id
    while (cur !== undefined) {
      const n = nodes.get(cur)
      if (!n) break
      const w = frameSource(n.callFrame.url)
      if (!seenFile.has(w)) {
        seenFile.add(w)
        files.set(w, (files.get(w) ?? 0) + 1)
      }
      if (ours(w)) {
        const f = n.callFrame.functionName || '(anonymous)'
        const k = `${f}\u0000${w}\u0000${n.callFrame.lineNumber}`
        if (!seenFn.has(k)) {
          seenFn.add(k)
          const m = mine.get(k) ?? { fn: f, where: w, n: 0 }
          m.n++
          mine.set(k, m)
        }
      }
      cur = parent.get(cur)
    }
  }
  const ms = (n: number) => Math.round(n * perSampleMs)
  const busy = profile.samples.length - idle
  return {
    seconds: Math.round(total / 1e5) / 10,
    busy_ms: ms(busy),
    idle_ms: ms(idle),
    gc_ms: ms(gc),
    self: [...self.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, top)
      .map((s) => ({ fn: s.fn, where: s.where, ms: ms(s.n) })),
    files: [...files.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([where, n]) => ({ where, ms: ms(n) })),
    ours: [...mine.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, top)
      .map((s) => ({ fn: s.fn, where: s.where, ms: ms(s.n) }))
  }
}
