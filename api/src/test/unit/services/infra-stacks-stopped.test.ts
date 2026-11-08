import { describe, expect, it } from 'vitest'
import { deriveService } from '../../../services/infra-swarm/stacks.js'

const svc = (replicas: number) =>
  ({
    ID: 's1',
    Spec: {
      Name: 'efp_api_directus',
      Labels: { 'com.docker.stack.namespace': 'efp_api' },
      Mode: { Replicated: { Replicas: replicas } },
      TaskTemplate: { ContainerSpec: { Image: 'directus/directus:11.17.4' } }
    },
    ServiceStatus: { RunningTasks: 0, DesiredTasks: replicas }
  }) as never
const failedTask = {
  ID: 't1',
  Slot: 1,
  CreatedAt: '2026-11-07T00:00:00Z',
  DesiredState: 'shutdown',
  Status: { State: 'failed', Err: 'task: non-zero exit (1)' }
} as never

describe('deriveService — a service scaled to 0 is stopped, not failing', () => {
  it('old failed tasks of a 0/0 service do not make it failing', () => {
    const s = deriveService(svc(0), [failedTask], new Map())
    expect(s.failing).toBe(false)
    expect(s.failing_reason).toBeNull()
  })
  it('a service that should run and has none running still fails', () => {
    const s = deriveService(svc(1), [failedTask], new Map())
    expect(s.failing).toBe(true)
  })
})
