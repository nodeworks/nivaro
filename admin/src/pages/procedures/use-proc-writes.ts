import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  dropPath,
  type ProcDetail,
  type ProcError,
  readProcError,
  restoreRequest,
  saveRequest
} from './status'

/**
 * Every write on one procedure, and the conflict a write can come back with:
 * - `drifted` (409 PROC_DRIFTED): the database changed since the page read it → keep the
 *   database's version (adopt keep_live) or overwrite with mine (resend with its live hash);
 * - `stale` (409 PROC_STALE): someone saved a newer config version → reload, then decide.
 * A 500 DEPLOY_STAMP_FAILED is a warning (deployed and kept, only the record failed).
 */

export type WriteOp = 'save' | 'restore' | 'drop'

export type Conflict =
  | {
      kind: 'drifted'
      op: Exclude<WriteOp, 'drop'>
      /** What this write would put live, for the diff against the database now. */
      mine: string
      /** The database's text now (null = not on it any more), fetched for the diff. */
      liveNow: string | null | undefined
      liveHash: string | null
      retry: (liveHash: string | null) => void
    }
  | { kind: 'stale'; op: WriteOp }

export const procKeys = {
  list: ['procedures'] as const,
  one: (name: string) => ['procedure', name] as const,
  versions: (name: string) => ['procedure-versions', name] as const,
  version: (name: string, v: number) => ['procedure-version', name, v] as const
}

const path = (name: string) => `/procedures/${encodeURIComponent(name)}`

interface SaveAnswer {
  ok: true
  created: boolean
  version: number
  unchanged: boolean
  deployed: { action: string; reason?: string }
}

export function useProcWrites(
  detail: ProcDetail | undefined,
  hooks: { onSaved?: () => void; onKeptLive?: (version: number) => void } = {}
) {
  const qc = useQueryClient()
  const name = detail?.name ?? ''
  const [conflict, setConflict] = useState<Conflict | null>(null)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: procKeys.list })
    void qc.invalidateQueries({ queryKey: procKeys.one(name) })
    void qc.invalidateQueries({ queryKey: procKeys.versions(name) })
  }

  /** The stamp-only 500: deployed, kept in config, only recording the deploy failed. */
  const stampWarning = (e: ProcError) =>
    toast.warning(
      `${name} deployed${e.version ? ` as version ${e.version}` : ''}, but recording the deploy failed`,
      {
        description:
          'Config keeps the new version. Readiness may show it as drifted until the next deploy records it.',
        duration: 12_000
      }
    )

  /** Fetch the database's text now, for the drift diff (best effort). */
  const fetchLiveNow = (op: Exclude<WriteOp, 'drop'>) => {
    api
      .get<{ data: ProcDetail }>(path(name))
      .then((r) => {
        setConflict((c) =>
          c?.kind === 'drifted' && c.op === op ? { ...c, liveNow: r.data.data.definition } : c
        )
      })
      .catch(() => {
        setConflict((c) => (c?.kind === 'drifted' && c.op === op ? { ...c, liveNow: null } : c))
      })
  }

  /** Common error routing; false = not handled (caller shows the message). */
  const route = (
    e: ProcError,
    op: WriteOp,
    drift?: { mine: string; retry: (h: string | null) => void }
  ): boolean => {
    if (e.code === 'PROC_DRIFTED' && drift && op !== 'drop') {
      setConflict({
        kind: 'drifted',
        op,
        mine: drift.mine,
        liveNow: undefined,
        liveHash: e.liveHash ?? null,
        retry: drift.retry
      })
      fetchLiveNow(op)
      return true
    }
    if (e.code === 'PROC_STALE') {
      setConflict({ kind: 'stale', op })
      return true
    }
    if (e.code === 'APP_MANAGED') {
      toast.error(e.message, { duration: 12_000 })
      refresh()
      return true
    }
    return false
  }

  const save = useMutation({
    mutationFn: (v: { definition: string; note: string; liveHash?: string | null }) =>
      api
        .put<SaveAnswer>(
          path(name),
          saveRequest(detail as ProcDetail, v.definition, v.note, v.liveHash)
        )
        .then((r) => r.data),
    onMutate: () => setConflict(null),
    onSuccess: (r) => {
      toast.success(
        r.unchanged
          ? `${name}: no change from version ${r.version}`
          : `${name}: saved version ${r.version} and deployed`
      )
      refresh()
      hooks.onSaved?.()
    },
    onError: (err, v) => {
      const e = readProcError(err, 'Deploy failed')
      if (e.stampOnly) {
        stampWarning(e)
        refresh()
        hooks.onSaved?.()
        return
      }
      if (
        route(e, 'save', {
          mine: v.definition,
          retry: (h) => save.mutate({ ...v, liveHash: h })
        })
      )
        return
      toast.error(e.message, { duration: 12_000 })
    }
  })

  const restore = useMutation({
    mutationFn: (v: { version: number; body: string; liveHash?: string | null }) =>
      api
        .post<{ data: { version: number; unchanged: boolean } }>(
          `${path(name)}/versions/${v.version}/restore`,
          restoreRequest(detail as ProcDetail, v.liveHash)
        )
        .then((r) => r.data.data),
    onMutate: () => setConflict(null),
    onSuccess: (r, v) => {
      toast.success(
        r.unchanged
          ? `${name}: version ${v.version} matches the current version; deployed it`
          : `${name}: version ${v.version} restored as version ${r.version} and deployed`
      )
      refresh()
      hooks.onSaved?.()
    },
    onError: (err, v) => {
      const e = readProcError(err, 'Restore failed')
      if (e.stampOnly) {
        stampWarning(e)
        refresh()
        return
      }
      if (
        route(e, 'restore', { mine: v.body, retry: (h) => restore.mutate({ ...v, liveHash: h }) })
      )
        return
      toast.error(e.message, { duration: 12_000 })
    }
  })

  /** POST /deploy — put config as it stands on this database (the drift fix, a pending drop). */
  const deployConfig = useMutation({
    mutationFn: () =>
      api.post<{ data: { action: string } }>(`${path(name)}/deploy`).then((r) => r.data.data),
    onMutate: () => setConflict(null),
    onSuccess: (r) => {
      toast.success(
        r.action === 'dropped'
          ? `${name} dropped from this database`
          : r.action === 'unchanged'
            ? `${name} was already deployed`
            : `${name} deployed from config`
      )
      refresh()
    },
    onError: (err) => {
      const e = readProcError(err, 'Deploy failed')
      if (e.stampOnly) {
        stampWarning(e)
        refresh()
        return
      }
      toast.error(e.message, { duration: 12_000 })
    }
  })

  /** POST /adopt — `keepLive` is the drift answer "keep the database's version". */
  const adopt = useMutation({
    mutationFn: (v: { keepLive: boolean }) =>
      api
        .post<{ data: { version: number; unchanged: boolean } }>(
          `${path(name)}/adopt${v.keepLive ? '?keep_live=1' : ''}`,
          {}
        )
        .then((r) => r.data.data),
    onSuccess: (r, v) => {
      setConflict(null)
      refresh()
      // The page says it (it may offer the set-aside edit back).
      if (v.keepLive && hooks.onKeptLive) hooks.onKeptLive(r.version)
      else
        toast.success(
          v.keepLive
            ? `Kept the database's version as version ${r.version}`
            : `${name} adopted as version ${r.version}`
        )
    },
    onError: (err) => {
      const e = readProcError(err, 'Adopt failed')
      if (e.code === 'PROC_ALREADY_MANAGED' || e.code === 'PROC_STALE') {
        toast.error('Someone adopted or saved it meanwhile. Reloaded.', { duration: 10_000 })
        refresh()
        return
      }
      if (route(e, 'save')) return
      toast.error(e.message, { duration: 12_000 })
    }
  })

  const drop = useMutation({
    mutationFn: () => api.delete(dropPath(detail as ProcDetail)),
    onMutate: () => setConflict(null),
    onSuccess: () => {
      toast.success(`${name} dropped. Its versions are kept.`)
      refresh()
    },
    onError: (err) => {
      const e = readProcError(err, 'Drop failed')
      if (e.stampOnly) {
        toast.warning(`${name} dropped, but recording the drop failed`, {
          description: 'Config keeps the drop; the next deploy records it.',
          duration: 12_000
        })
        refresh()
        return
      }
      if (route(e, 'drop')) return
      toast.error(e.message, { duration: 12_000 })
      if (e.configDropped !== undefined) refresh()
    }
  })

  const busy =
    save.isPending ||
    restore.isPending ||
    deployConfig.isPending ||
    adopt.isPending ||
    drop.isPending

  return {
    save,
    restore,
    deployConfig,
    adopt,
    drop,
    busy,
    conflict,
    clearConflict: () => setConflict(null),
    /** Reload after PROC_STALE: fresh config + versions; the caller keeps its draft. */
    reload: () => {
      setConflict(null)
      refresh()
    }
  }
}
