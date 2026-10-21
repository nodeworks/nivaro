import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { api } from '@/lib/api'

/** GET /api/infrastructure/status — shared by every tab (one cached read). */
export interface InfraStatus {
  cloud: boolean
  docker: {
    configured: boolean
    hosts: Array<{
      host: string
      error: string | null
      data: {
        engine: string | null
        api: string | null
        hostname: string | null
        os: string | null
        kernel: string | null
        cpus: number | null
        memory_bytes: number | null
        swarm: string | null
        manager: boolean
      } | null
    }>
  }
  metrics_store: boolean
}

export function useInfraStatus() {
  return useQuery({
    queryKey: ['infrastructure', 'status'],
    queryFn: async () => (await api.get('/infrastructure/status')).data.data as InfraStatus,
    staleTime: 15_000
  })
}

/** One host's read failed; the rest of the tab still renders. */
export function HostError({ host, error }: { host: string; error: string }) {
  return (
    <div className='flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
      <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
      <span>
        <span className='font-medium'>{host}:</span> {error}
      </span>
    </div>
  )
}

/** Shown by any Docker-backed tab when no Docker host is configured. */
export function DockerNotConfigured({ children }: { children?: ReactNode }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-6 text-[13px] dark:border-border dark:bg-card'>
      <p className='font-medium text-slate-900 dark:text-foreground'>No Docker host is connected</p>
      <p className='mt-1 max-w-prose text-slate-600 dark:text-muted-foreground'>
        Run a read-only Docker socket proxy (GET only) on an internal network and set{' '}
        <code className='rounded bg-slate-100 px-1 py-0.5 text-[12px] dark:bg-muted'>
          DOCKER_HOSTS=name=http://proxy:2375
        </code>{' '}
        on this instance. Nivaro never mounts the Docker socket itself.
      </p>
      {children}
    </div>
  )
}
