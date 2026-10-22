import { registerFault } from '../catalog.js'
import { onStopAll } from '../registry.js'

/**
 * Socket drills (#2463) as a catalog entry (#2827). The drill itself stays in
 * `services/socket-chaos.ts` (its own targets, counters and console on /realtime?tab=verify);
 * this entry only lets a run arm one and lets Stop all end every socket drill, including ones
 * started from the Realtime page.
 */

registerFault({
  key: 'socket_drill',
  label: 'Socket drill',
  area: 'socket',
  proves:
    'Sockets reconnect and catch up: dropped or delayed packets and forced disconnects end in the reconnect banner, the offline outbox and a catch-up, nothing lost.',
  claim_keys: ['sockets.reconnect_catchup'],
  targets: ['room', 'user', 'share'],
  params: {
    latency_ms: { type: 'number', label: 'Latency', min: 0, max: 10_000, default: 0, unit: 'ms' },
    drop_pct: { type: 'number', label: 'Dropped packets', min: 0, max: 100, default: 0, unit: '%' },
    disconnect: {
      type: 'enum',
      label: 'Disconnect',
      options: ['none', 'once', 'every'],
      default: 'none'
    },
    disconnect_every_s: { type: 'number', label: 'Every', min: 5, max: 300, default: 30, unit: 's' }
  },
  max_seconds: 600,
  default_seconds: 60,
  points: [],
  danger: 'medium',
  console_href: '/realtime?tab=verify',
  apply_scope: 'origin',
  async apply(fault) {
    const { startChaos, stopChaos } = await import('../../socket-chaos.js')
    const t = fault.target
    const target =
      t.kind === 'room'
        ? { kind: 'room', room: t.room }
        : t.kind === 'user'
          ? { kind: 'user', user_id: t.user_id }
          : { kind: 'share', share_pct: t.kind === 'share' ? t.share_pct : 100 }
    const spec = await startChaos(
      {
        target,
        fault: {
          latency_ms: fault.params.latency_ms,
          drop_pct: fault.params.drop_pct,
          disconnect: fault.params.disconnect,
          disconnect_every_s: fault.params.disconnect_every_s
        },
        seconds: Math.max(5, Math.round((fault.ends_at - Date.now()) / 1000))
      },
      { id: fault.started_by, name: fault.started_by_name }
    )
    return () => stopChaos(spec.id).then(() => undefined)
  }
})

// Stop all ends socket drills started outside the registry too (the Realtime page's own form).
onStopAll(async () => {
  const { listChaosRuns, stopChaos } = await import('../../socket-chaos.js')
  const now = Date.now()
  for (const run of await listChaosRuns(5)) {
    if (run.spec.ends_at > now) await stopChaos(run.spec.id)
  }
})
