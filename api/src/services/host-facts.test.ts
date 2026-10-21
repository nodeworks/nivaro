import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  filesystemFor,
  type HostFacts,
  hungStatus,
  type NodeSignals,
  parseHostFacts,
  patchStatus,
  readHostFacts,
  resetHostFactsCacheForTests
} from './host-facts.js'
import { type MetricSample, setStoreFetchForTests } from './telemetry-store.js'

const NOW = 1_761_100_000_000
const m = (name: string, labels: Record<string, string>, value: number): MetricSample => ({
  labels: { __name__: name, host: 'staging', ...labels },
  value
})

const SAMPLES: MetricSample[] = [
  m('nivaro_host_kernel_running_info', { version: '4.18.0-477' }, 1),
  m('nivaro_host_kernel_installed_info', { version: '4.18.0-513' }, 1),
  m('nivaro_host_reboot_required', {}, 1),
  m('nivaro_host_boot_time_seconds', {}, NOW / 1000 - 40 * 86400),
  m('nivaro_host_security_updates', {}, 3),
  m('nivaro_host_boot_free_bytes', {}, 80 * 1024 * 1024),
  m('nivaro_host_dstate_processes', {}, 14),
  m('nivaro_host_hung_task_events', {}, 2),
  m('nivaro_host_nfs_not_responding', { server: 'nas01' }, 1),
  m('nivaro_host_nfs_not_responding', { server: 'nas02' }, 0),
  m('nivaro_host_mount_nofail', { mountpoint: '/mnt/data', fstype: 'nfs4' }, 0),
  m('nivaro_host_mount_nofail', { mountpoint: '/mnt/b', fstype: 'nfs' }, 1),
  m('nivaro_host_docker_waits_for_mounts', { mountpoint: '/mnt/b' }, 1),
  m('nivaro_host_docker_waits_for_mounts', { mountpoint: '/mnt/data' }, 0),
  m('nivaro_host_container_log_bytes', { container: 'web' }, 1234),
  m('nivaro_host_volume_last_write_seconds', { volume: 'pg' }, 1_761_000_000),
  m('nivaro_host_swarm_node_cert_expiry_seconds', {}, 1_798_761_600),
  m('nivaro_host_facts_last_run_seconds', {}, NOW / 1000 - 60)
]

function signals(over: Partial<NodeSignals> = {}): NodeSignals {
  return {
    load1: 1,
    cpus: 8,
    idle: 0.9,
    iowait: 0.01,
    filesystems: [],
    space: [],
    ...over
  }
}

describe('parseHostFacts', () => {
  it('builds per-host facts from the collector metrics', () => {
    const f = parseHostFacts(SAMPLES, [], NOW).get('staging') as HostFacts
    expect(f.kernel_running).toBe('4.18.0-477')
    expect(f.kernel_installed).toBe('4.18.0-513')
    expect(f.reboot_required).toBe(true)
    expect(f.security_updates).toBe(3)
    expect(f.nfs).toEqual([
      { server: 'nas01', not_responding: true },
      { server: 'nas02', not_responding: false }
    ])
    expect(f.mounts).toEqual([
      { mountpoint: '/mnt/b', fstype: 'nfs', nofail: true, docker_waits: true },
      { mountpoint: '/mnt/data', fstype: 'nfs4', nofail: false, docker_waits: false }
    ])
    expect(f.container_log_bytes).toEqual({ web: 1234 })
    expect(f.volume_last_write.pg).toBe(1_761_000_000_000)
    expect(f.swarm_cert_expiry).toBe(1_798_761_600_000)
    expect(f.collected_at).toBe(NOW - 60_000)
    expect(f.stale).toBe(false)
  })

  it('knows a host that stopped reporting only from its last run, and calls it stale', () => {
    const f = parseHostFacts(
      [],
      [{ labels: { host: 'prod' }, value: NOW / 1000 - 3 * 3600 }],
      NOW
    ).get('prod') as HostFacts
    expect(f.collected_at).toBe(NOW - 3 * 3600_000)
    expect(f.stale).toBe(true)
    expect(f.kernel_running).toBeNull()
  })
})

describe('patchStatus', () => {
  it('flags reboot, low /boot and waiting security updates', () => {
    const f = parseHostFacts(SAMPLES, [], NOW).get('staging') as HostFacts
    const p = patchStatus(f, NOW)
    expect(p.level).toBe('critical')
    expect(p.boot_low).toBe(true)
    expect(p.kernel_pending).toBe(true)
    expect(p.days_since_boot).toBe(40)
    expect(p.notes.join(' ')).toMatch(/reboot is needed/)
    expect(p.notes.join(' ')).toMatch(/\/boot has 80 MB free/)
    expect(p.notes.join(' ')).toMatch(/3 security updates waiting/)
  })

  it('is unknown when the host facts are not collected', () => {
    expect(patchStatus(null).level).toBe('unknown')
  })

  it('is ok for a patched host', () => {
    const f = parseHostFacts(
      [
        m('nivaro_host_kernel_running_info', { version: 'k1' }, 1),
        m('nivaro_host_kernel_installed_info', { version: 'k1' }, 1),
        m('nivaro_host_reboot_required', {}, 0),
        m('nivaro_host_security_updates', {}, 0),
        m('nivaro_host_boot_free_bytes', {}, 500 * 1048576),
        m('nivaro_host_facts_last_run_seconds', {}, NOW / 1000)
      ],
      [],
      NOW
    ).get('staging') as HostFacts
    expect(patchStatus(f, NOW)).toMatchObject({ level: 'ok', notes: [] })
  })
})

describe('hungStatus', () => {
  const facts = parseHostFacts(SAMPLES, [], NOW).get('staging') as HostFacts

  it('names the mount when load is high while the CPU idles', () => {
    const h = hungStatus(
      facts,
      signals({
        load1: 22,
        cpus: 4,
        idle: 0.9,
        filesystems: [
          { mountpoint: '/mnt/data', device: 'nas01:/export', fstype: 'nfs4', error: true }
        ]
      })
    )
    expect(h.level).toBe('critical')
    expect(h.headline).toBe(
      'Load 22 while the CPU is 90% idle — processes are waiting on IO, likely the mount /mnt/data (NFS server nas01 is not responding).'
    )
    expect(h.suspect_mount).toBe('/mnt/data')
  })

  it('is critical on hung tasks with processes stuck in D state', () => {
    const h = hungStatus(facts, signals())
    expect(h.level).toBe('critical')
    expect(h.headline).toMatch(/^2 hung-task messages .* 14 processes stuck on IO/)
  })

  it('warns on an NFS server that stopped answering', () => {
    const f = { ...facts, hung_task_events: 0, dstate_processes: 0 }
    const h = hungStatus(f, signals())
    expect(h.level).toBe('warning')
    expect(h.headline).toBe('NFS server nas01 is not responding.')
  })

  it('is ok on a busy but healthy host, and unknown with nothing to go on', () => {
    const f = { ...facts, hung_task_events: 0, dstate_processes: 1, nfs: [] }
    expect(hungStatus(f, signals({ load1: 30, cpus: 8, idle: 0.1 })).level).toBe('ok')
    expect(hungStatus(null, null).level).toBe('unknown')
  })
})

describe('filesystemFor', () => {
  it('picks the longest mountpoint that holds the path', () => {
    const list = [{ mountpoint: '/' }, { mountpoint: '/var' }, { mountpoint: '/var/lib/docker2' }]
    expect(filesystemFor(list, '/var/lib/docker')?.mountpoint).toBe('/var')
    expect(filesystemFor(list, '/opt')?.mountpoint).toBe('/')
    expect(filesystemFor([{ mountpoint: '/var' }], '/opt')).toBeNull()
  })
})

describe('readHostFacts', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.CLOUD_META_DB_URL
    resetHostFactsCacheForTests()
  })
  afterEach(() => {
    process.env = { ...saved }
    setStoreFetchForTests(null)
    resetHostFactsCacheForTests()
  })

  it('reports no store when the telemetry store is not configured', async () => {
    delete process.env.TELEMETRY_STORE_URL
    const r = await readHostFacts()
    expect(r.store).toBe(false)
    expect(r.facts.size).toBe(0)
  })

  it('reads the facts and node signals with fixed expressions', async () => {
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    const asked: string[] = []
    setStoreFetchForTests(async (_url, init) => {
      const q = new URLSearchParams(String(init.body)).get('query') ?? ''
      asked.push(q)
      const result = q.startsWith('last_over_time({__name__')
        ? [
            {
              metric: { __name__: 'nivaro_host_dstate_processes', host: 'staging' },
              value: [0, '3']
            }
          ]
        : q.includes('node_load1')
          ? [{ metric: { host: 'staging' }, value: [0, '2.5'] }]
          : []
      return new Response(JSON.stringify({ data: { result } }), { status: 200 })
    })
    const r = await readHostFacts(NOW)
    expect(r.store).toBe(true)
    expect(r.error).toBeNull()
    expect(r.facts.get('staging')?.dstate_processes).toBe(3)
    expect(r.signals.get('staging')?.load1).toBe(2.5)
    expect(asked).toHaveLength(9)
  })

  it('reports the store error but never throws', async () => {
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    setStoreFetchForTests(async () => new Response('no', { status: 502 }))
    const r = await readHostFacts(NOW)
    expect(r.store).toBe(true)
    expect(r.error).toMatch(/502/)
    expect(r.facts.size).toBe(0)
  })
})
