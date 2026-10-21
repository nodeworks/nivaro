import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { type EntryConfig, type EntryMode, isBeginner } from '../../../lib/entry-config'

/**
 * Beginner and expert modes (#2710): a form that sets `adaptive` shows guided steps
 * to a person who has made fewer than `adaptive_threshold` records of the
 * collection and tabs after that. A person can switch; the choice is theirs per
 * form, in this browser. Off (null) when the form does not ask for it, when the
 * count cannot be read, or when the form has no tabs to turn into steps.
 */

const key = (userId: string, layoutId: number | null) =>
  `nivaro:entry-mode:${userId || 'anon'}:${layoutId ?? 'x'}`

function readPick(k: string): EntryMode | null {
  try {
    const v = localStorage.getItem(k)
    return v === 'beginner' || v === 'expert' ? v : null
  } catch {
    return null
  }
}

/** How many records of `collection` the person created (capped at the threshold). */
export function useRecordsMade(collection: string, userId: string, cap: number, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<number | null>({
    queryKey: ['entry-records-made', collection, userId, cap],
    enabled: enabled && !!userId && !!collection,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async () => {
      try {
        const r = await client.request<{ data?: unknown[] }>(
          get(`/items/${encodeURIComponent(collection)}`, {
            limit: cap,
            fields: 'id',
            filter: JSON.stringify({ user_created: { _eq: userId } })
          })
        )
        return r?.data?.length ?? 0
      } catch {
        return null
      }
    }
  })
}

export interface EntryModeState {
  /** The mode in force, null = the form's own tab mode stands. */
  mode: EntryMode | null
  /** The form is adaptive and a switch should show. */
  switchable: boolean
  /** The count says beginner, whatever the person picked. */
  auto: EntryMode | null
  set(mode: EntryMode | null): void
}

export function useEntryMode(args: {
  collection: string
  layoutId: number | null
  userId: string
  config: EntryConfig
  /** The form has tabs or steps to switch between. */
  hasTabs: boolean
  enabled: boolean
}): EntryModeState {
  const { collection, layoutId, userId, config, hasTabs, enabled } = args
  const on = enabled && config.adaptive === true && hasTabs
  const cap = config.adaptive_threshold ?? 3
  const { data: made } = useRecordsMade(collection, userId, cap, on)
  const k = key(userId, layoutId)
  const [pick, setPick] = useState<EntryMode | null>(() => readPick(k))
  useEffect(() => setPick(readPick(k)), [k])
  const set = useCallback(
    (m: EntryMode | null) => {
      setPick(m)
      try {
        if (m) localStorage.setItem(k, m)
        else localStorage.removeItem(k)
      } catch {
        // storage blocked: the pick lasts until the page closes
      }
    },
    [k]
  )
  if (!on || made == null) return { mode: null, switchable: false, auto: null, set }
  const auto: EntryMode = isBeginner(made, config) ? 'beginner' : 'expert'
  return { mode: pick ?? auto, switchable: true, auto, set }
}
