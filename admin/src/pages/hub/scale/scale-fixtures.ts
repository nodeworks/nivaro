import type { ScalePlan, TargetDetail, TargetView } from './scale-api'

/** Sample answers of /api/hub/scale* for the tab's tests (one large dedicated stack). */

const roles: TargetView['roles'] = [
  {
    role: 'web',
    replicas: 4,
    cpus: 2,
    memory_mb: 3072,
    template: { replicas: 3, cpus: 2, memory_mb: 3072 },
    scalable: true,
    min: 1,
    pinned: false,
    auto: {
      enabled: true,
      min: 3,
      max: 6,
      metrics: [{ metric: 'cpu_pct', out_above: 70, in_below: 30 }],
      sustain: 3,
      sustain_in: 10,
      cooldown_out_min: 5,
      cooldown_in_min: 15,
      step_every_min: 10,
      step: 1,
      schedules: [
        { days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00', zone: 'America/New_York', min: 4 }
      ]
    },
    metrics: ['cpu_pct', 'memory_pct', 'requests_per_min', 'p95_ms', 'heavy_queue'],
    max_hits: 0,
    last_change_at: '2026-11-25T14:10:00.000Z'
  },
  {
    role: 'worker',
    replicas: 1,
    cpus: 2,
    memory_mb: 4096,
    template: { replicas: 1, cpus: 2, memory_mb: 4096 },
    scalable: false,
    min: 1,
    pinned: false,
    auto: null,
    metrics: [],
    max_hits: 0,
    last_change_at: null
  },
  {
    role: 'realtime',
    replicas: 2,
    cpus: 1,
    memory_mb: 1024,
    template: { replicas: 2, cpus: 1, memory_mb: 1024 },
    scalable: true,
    min: 1,
    pinned: true,
    auto: null,
    metrics: ['cpu_pct', 'memory_pct'],
    max_hits: 0,
    last_change_at: null
  }
]

export const OVERVIEW: { targets: TargetView[] } = {
  targets: [
    {
      kind: 'environment',
      id: 1,
      key: 'acme/production',
      label: 'Acme · production',
      production: true,
      stack: 'acme-prod',
      size: 'large',
      version: '0.3.215',
      sqlite: false,
      unusable: null,
      roles,
      autoscaling: true,
      maxed: false,
      open_run: null,
      last_run: null
    },
    {
      kind: 'shared',
      id: 2,
      key: 'shared-eu',
      label: 'Shared EU',
      production: true,
      stack: 'shared-eu',
      size: 'medium',
      version: '0.3.215',
      sqlite: false,
      unusable: null,
      roles: roles.slice(0, 2),
      autoscaling: false,
      maxed: true,
      open_run: null,
      last_run: null
    }
  ]
}

export const DETAIL: TargetDetail = {
  ...OVERVIEW.targets[0],
  roles: roles.map((r) => ({ ...r, running: { desired: r.replicas, running: r.replicas } })),
  status: { state: 'converged', spec_hash: 'a'.repeat(64) },
  now: {
    connections: {
      kind: 'environment',
      processes: { from: 7, to: 7 },
      per_process: 70,
      pools: { main: 60, background: 10 },
      total: { from: 490, to: 490 },
      servers: [
        {
          id: 1,
          name: 'sql-prod-1',
          max_connections: 1200,
          others: 300,
          from: 490,
          to: 490,
          after: 790,
          fits: true
        }
      ],
      unknown: []
    },
    blockers: [],
    warnings: [],
    agent: { version: '0.2.4', ok: true },
    caps: { max_replicas: 10, max_total_replicas: 30, cpus: [0.1, 16], memory_mb: [128, 65536] },
    confirm: 'production'
  },
  runs: [
    {
      id: 12,
      target_kind: 'environment',
      target_id: 1,
      stack: 'acme-prod',
      source: 'auto',
      status: 'success',
      reason: 'web 3 → 4: CPU (% of the limit) 86 > 70 for 3 checks.',
      figures: null,
      from: roles.map((r) => ({
        role: r.role,
        replicas: r.role === 'web' ? 3 : r.replicas,
        cpus: r.cpus,
        memory_mb: r.memory_mb
      })),
      to: roles.map((r) => ({
        role: r.role,
        replicas: r.replicas,
        cpus: r.cpus,
        memory_mb: r.memory_mb
      })),
      steps: [],
      step_index: 1,
      error_code: null,
      error: null,
      started_by: null,
      created_at: '2026-11-25T14:10:00.000Z',
      finished_at: '2026-11-25T14:11:00.000Z'
    },
    {
      id: 11,
      target_kind: 'environment',
      target_id: 1,
      stack: 'acme-prod',
      source: 'auto',
      status: 'skipped',
      reason: 'Paused (A release freeze is on (Month end).) — would have: web 4 → 5',
      figures: null,
      from: [],
      to: [],
      steps: [],
      step_index: 0,
      error_code: 'FROZEN',
      error: null,
      started_by: null,
      created_at: '2026-11-24T22:00:00.000Z',
      finished_at: '2026-11-24T22:00:00.000Z'
    }
  ]
}

export const PLAN: ScalePlan = {
  kind: 'environment',
  id: 1,
  from: DETAIL.runs[0].to,
  to: DETAIL.runs[0].to.map((r) => (r.role === 'web' ? { ...r, replicas: 6 } : r)),
  changes: [{ role: 'web', replicas: 6 }],
  steps: [DETAIL.runs[0].to.map((r) => (r.role === 'web' ? { ...r, replicas: 6 } : r))],
  connections: {
    ...DETAIL.now.connections,
    processes: { from: 7, to: 9 },
    total: { from: 490, to: 630 },
    servers: [{ ...DETAIL.now.connections.servers[0], to: 630, after: 930 }]
  },
  blockers: [],
  warnings: [],
  confirm: 'production',
  plan_hash: 'p'.repeat(64)
}
