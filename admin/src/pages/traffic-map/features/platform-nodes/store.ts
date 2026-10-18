// Platform nodes: the one poll (GET /traffic-map/platform-nodes) every piece reads, plus a module
// copy the canvas layers and badges read synchronously between polls.
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useTrafficMap } from '../../context'
import { requestCanvasRepaint } from '../../registry/canvasLayers'
import { useFrozenSnapshotId } from '../snapshots'
import type { PlatformNodes } from './logic'

const POLL_MS = 15_000

let current: PlatformNodes | null = null
export const platformNow = (): PlatformNodes | null => current
export function setPlatform(v: PlatformNodes | null): void {
  current = v
  requestCanvasRepaint()
}

/** Polled while the map is live (not paused, not a frozen snapshot); one key, shared. */
export function usePlatformNodes() {
  const { paused, ready } = useTrafficMap()
  const frozen = useFrozenSnapshotId()
  return useQuery({
    queryKey: ['traffic-map', 'platform-nodes'],
    queryFn: async () => (await api.get('/traffic-map/platform-nodes')).data.data as PlatformNodes,
    enabled: ready && !frozen,
    refetchInterval: paused ? false : POLL_MS,
    refetchIntervalInBackground: false,
    staleTime: POLL_MS - 1000
  })
}
