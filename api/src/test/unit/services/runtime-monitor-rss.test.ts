import { describe, expect, it } from 'vitest'
import { cgroupMemoryLimitMb, rssWarnMb } from '../../../services/runtime-monitor.js'

describe('runtime monitor RSS warn level', () => {
  it('reads a cgroup v2 limit', () => {
    const read = (p: string) => (p === '/sys/fs/cgroup/memory.max' ? `${8192 * 1048576}\n` : null)
    expect(cgroupMemoryLimitMb(read)).toBe(8192)
  })

  it('falls back to cgroup v1 and ignores "max" / the no-limit sentinel', () => {
    const v1 = (p: string) =>
      p === '/sys/fs/cgroup/memory.max'
        ? 'max'
        : p.endsWith('limit_in_bytes')
          ? `${6144 * 1048576}`
          : null
    expect(cgroupMemoryLimitMb(v1)).toBe(6144)
    const none = (p: string) => (p.endsWith('limit_in_bytes') ? '9223372036854771712' : null)
    expect(cgroupMemoryLimitMb(none)).toBeNull()
    expect(cgroupMemoryLimitMb(() => null)).toBeNull()
  })

  it('env wins, else 80% of the limit, never under 2048', () => {
    expect(rssWarnMb('3000', 8192)).toBe(3000)
    expect(rssWarnMb(undefined, 8192)).toBe(6553)
    expect(rssWarnMb(undefined, 1024)).toBe(2048)
    expect(rssWarnMb(undefined, null)).toBe(2048)
    expect(rssWarnMb('nope', 6144)).toBe(4915)
  })
})
