import { Lock, LockOpen } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { idleState } from '../../lib/idle'
import { useOptionalRealtime } from '../../lib/realtime'
import { announceRecordTabs, useRecordTabsSignal } from '../../lib/record-tabs'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

const HEARTBEAT_MS = 60_000
/** A lock held by a form that is off screen (hidden browser tab, background
 *  workspace tab) is let go after this long; it comes back on return. */
const OFF_SCREEN_RELEASE_MS = 2 * 60_000

export interface LockHolder {
  locked_by: string
  locked_by_name: string | null
  /** The holder's intent note (#10) — "editing lines ~15 min". */
  note?: string | null
  /** Minutes since the holder last did anything (presence), when known. */
  idle_minutes?: number | null
  /** Whether THIS viewer may force-take the lock (server verdict; absent =
   *  unknown, the button shows and the server's 403 explains). */
  may_take_over?: boolean
}

export interface LockQueueEntry {
  user: string
  name: string | null
  requested_at: string
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
  )
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible
}

export function useItemLock(
  collection: string | undefined,
  item: string | undefined,
  enabled: boolean,
  opts: {
    /** Take the lock on the first real edit (`claim`), not on open — opening
     *  a record only learns whether someone else holds it. A reader who never
     *  edits (an approver re-opening what they sent back) never blocks the
     *  person who has to fix it. */
    lazy?: boolean
    /** False = mounted but not on screen (a background workspace tab). */
    active?: boolean
  } = {}
) {
  const { lazy = false, active = true } = opts
  const client = useNivaroClient()
  const { isAdmin, userId } = useItemEditAuth()
  const [lockHolder, setLockHolder] = useState<LockHolder | null>(null)
  const [acquired, setAcquired] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  // Lock intent + wait queue (#10): the holder's note and who is waiting,
  // read from GET lock whenever we learn someone else holds it.
  const [queue, setQueue] = useState<LockQueueEntry[]>([])
  const [myPosition, setMyPosition] = useState<number | null>(null)
  const [joining, setJoining] = useState(false)
  const [myNote, setMyNote] = useState('')
  // Manual release (2026-09-14): the holder can free the record from the
  // header pill at any time, waiting room or not. `released` keeps the pill
  // visible as an unlocked glyph so they can lock it again; the form's next
  // real edit re-acquires via `relock`.
  const [released, setReleased] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const acquiredRef = useRef(false)
  // Let go because the form went off screen (or the page was hidden) — taken
  // back the moment it is shown again.
  const offScreenReleasedRef = useRef(false)
  const claimingRef = useRef(false)
  // The lock routes answer 404 for a record this person cannot read: there is
  // nothing to lock, so stop asking (no heartbeat, no retries, no banner).
  const notVisibleRef = useRef(false)
  // Why the last acquire failed — only a 409 means "someone else is editing".
  const lastRefusalRef = useRef<number | null>(null)

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
    }
  }, [])

  const acquire = useCallback(async () => {
    if (!collection || !item || notVisibleRef.current) return false
    lastRefusalRef.current = null
    try {
      await client.request(post(`/item-locks/${collection}/${item}/lock`, {}))
      acquiredRef.current = true
      setAcquired(true)
      setReleased(false)
      setLockHolder(null)
      stopHeartbeat()
      heartbeatRef.current = setInterval(() => {
        // Report how long since real input — the server releases the lock past
        // settings.lock_idle_release_minutes so an abandoned tab frees the record.
        const idleSecs = Math.max(
          0,
          Math.floor((Date.now() - new Date(idleState().last_active).getTime()) / 1000)
        )
        client
          .request(post(`/item-locks/${collection}/${item}/heartbeat`, { idle_seconds: idleSecs }))
          .then((r) => {
            if (!(r as { idle_released?: boolean } | null)?.idle_released) return
            stopHeartbeat()
            acquiredRef.current = false
            setAcquired(false)
            toast.info(
              'Your edit lock was released after inactivity — it re-locks when you resume.'
            )
            // Re-acquire on the next real input, if the record is still free.
            const resume = () => {
              window.removeEventListener('pointerdown', resume, true)
              window.removeEventListener('keydown', resume, true)
              acquire()
            }
            window.addEventListener('pointerdown', resume, true)
            window.addEventListener('keydown', resume, true)
          })
          .catch((err: unknown) => {
            // The heartbeat is the ONLY moment a client learns its lock was
            // taken over. Swallowing the failure left the loser editing a
            // record someone else now owns, with no banner and no hint — the
            // two of them overwriting each other on save.
            const e = err as {
              status?: number
              response?: (LockHolder & { status?: number; data?: LockHolder }) | undefined
            }
            const status = e.status ?? e.response?.status
            if (status !== 404 && status !== 409) return
            const body = (e.response?.data ?? e.response) as LockHolder | undefined
            // Nobody holds it any more — another window of this person let it
            // go (#2131) or it lapsed: take it back rather than edit unlocked.
            if (status === 404 && !body?.locked_by) {
              void acquire()
              return
            }
            stopHeartbeat()
            acquiredRef.current = false
            setAcquired(false)
            if (body?.locked_by) {
              setLockHolder({
                locked_by: body.locked_by,
                locked_by_name: body.locked_by_name ?? null
              })
              toast.warning(
                `${body.locked_by_name ?? 'Another user'} took over editing — your changes are no longer being saved`
              )
            }
          })
      }, HEARTBEAT_MS)
      return true
    } catch (err: unknown) {
      // The SDK puts the HTTP code on `err.status` and the PARSED BODY on
      // `err.response` — not an axios-shaped {response:{status,data}}. Reading
      // it the axios way found undefined, so the 409 branch never ran and the
      // second person to open a record was told nothing: no banner, no
      // read-only, and a save that quietly fought the lock holder. Both shapes
      // are accepted here because admin passes an axios-backed client.
      const e = err as {
        status?: number
        response?: (LockHolder & { status?: number; data?: LockHolder }) | undefined
      }
      const status = e.status ?? e.response?.status
      const body = (e.response?.data ?? e.response) as LockHolder | undefined
      lastRefusalRef.current = status ?? null
      if (status === 404) {
        notVisibleRef.current = true
        stopHeartbeat()
        acquiredRef.current = false
        setAcquired(false)
        return false
      }
      if (status === 409 && body?.locked_by) {
        acquiredRef.current = false
        setAcquired(false)
        setLockHolder({
          locked_by: body.locked_by,
          locked_by_name: body.locked_by_name ?? null,
          ...(typeof body.may_take_over === 'boolean' ? { may_take_over: body.may_take_over } : {})
        })
      }
      return false
    }
  }, [client, collection, item, stopHeartbeat])

  const refreshLockInfo = useCallback(async () => {
    if (!collection || !item) return
    try {
      const r = await client.request<{
        data: {
          locked_by?: string | null
          locked_by_name?: string | null
          note?: string | null
          locked_by_idle_minutes?: number | null
          is_mine?: boolean
          may_take_over?: boolean
          queue?: LockQueueEntry[]
          my_position?: number | null
        } | null
      }>(get(`/item-locks/${collection}/${item}/lock`))
      const d = (r as { data?: unknown })?.data as
        | {
            locked_by?: string | null
            locked_by_name?: string | null
            note?: string | null
            locked_by_idle_minutes?: number | null
            is_mine?: boolean
            may_take_over?: boolean
            queue?: LockQueueEntry[]
            my_position?: number | null
          }
        | null
        | undefined
      setQueue(Array.isArray(d?.queue) ? d.queue : [])
      setMyPosition(typeof d?.my_position === 'number' ? d.my_position : null)
      // This person's own lock (another of their windows) is not "someone
      // else is editing" — the next acquire simply takes it over.
      const mine =
        d?.is_mine === true ||
        (!!userId && String(d?.locked_by ?? '').toLowerCase() === userId.toLowerCase())
      const canTakeOver =
        typeof d?.may_take_over === 'boolean' ? { may_take_over: d.may_take_over } : {}
      if (d?.locked_by && !acquiredRef.current && !mine)
        setLockHolder((cur) =>
          cur
            ? {
                ...cur,
                note: d.note ?? cur.note ?? null,
                idle_minutes: d.locked_by_idle_minutes ?? cur.idle_minutes ?? null,
                ...canTakeOver
              }
            : {
                locked_by: String(d.locked_by),
                locked_by_name: d.locked_by_name ?? null,
                note: d.note ?? null,
                ...canTakeOver
              }
        )
    } catch (err) {
      if ((err as { status?: number })?.status === 404) notVisibleRef.current = true
      /* otherwise the banner works without the extras */
    }
  }, [client, collection, item, userId])
  // Keyed on the holder's ID, not the object: refreshLockInfo rewrites the
  // holder object (note/queue) and an object-keyed effect would loop.
  const lockedById = lockHolder?.locked_by ?? null
  useEffect(() => {
    if (lockedById) void refreshLockInfo()
  }, [lockedById, refreshLockInfo])

  useEffect(() => {
    if (!enabled || !collection || !item) return
    offScreenReleasedRef.current = false
    notVisibleRef.current = false
    if (lazy) void refreshLockInfo()
    else acquire()
    return () => {
      stopHeartbeat()
      offScreenReleasedRef.current = false
      if (acquiredRef.current) {
        acquiredRef.current = false
        client
          .request(del(`/item-locks/${collection}/${item}/lock`))
          .then(() => announceRecordTabs(userId, 'lock-released', collection, item))
          .catch(() => {})
      }
    }
  }, [enabled, collection, item, acquire, client, stopHeartbeat, userId, lazy, refreshLockInfo])

  /** Real edit intent (lazy mode): take the lock now, once. A 409 lands in
   *  lockHolder like any acquire — the form turns read-only and says who. */
  const claim = useCallback(async () => {
    if (!enabled || acquiredRef.current || claimingRef.current) return
    claimingRef.current = true
    try {
      const ok = await acquire()
      if (!ok && lastRefusalRef.current === 409)
        toast.warning('Someone else is editing this record — your change can’t be saved yet')
    } finally {
      claimingRef.current = false
    }
  }, [enabled, acquire])

  // Off screen (hidden browser tab, background workspace tab): stop holding
  // the record for others after a while; take it back on return.
  const visible = useDocumentVisible()
  const onScreen = active && visible
  useEffect(() => {
    if (!enabled || !collection || !item) return
    if (onScreen) {
      if (offScreenReleasedRef.current) {
        offScreenReleasedRef.current = false
        void acquire()
      }
      return
    }
    const t = setTimeout(() => {
      if (!acquiredRef.current) return
      stopHeartbeat()
      acquiredRef.current = false
      setAcquired(false)
      offScreenReleasedRef.current = true
      client
        .request(del(`/item-locks/${collection}/${item}/lock`))
        .then(() => announceRecordTabs(userId, 'lock-released', collection, item))
        .catch(() => {})
    }, OFF_SCREEN_RELEASE_MS)
    return () => clearTimeout(t)
  }, [enabled, onScreen, collection, item, acquire, client, stopHeartbeat, userId])

  // Leaving the page (close, reload, cross-document navigation): an unmount
  // cleanup's request rarely makes it out, so the lock sat until its TTL ran
  // out. A keepalive DELETE survives the page going away.
  useEffect(() => {
    if (!enabled || !collection || !item) return
    const onPageHide = () => {
      if (!acquiredRef.current) return
      stopHeartbeat()
      acquiredRef.current = false
      offScreenReleasedRef.current = true // a back/forward-cache restore retakes it
      try {
        const token = client.getToken?.()
        const base = (client as { url?: string }).url ?? ''
        // lock/release lets go of the caller's OWN lock only — safe to fire
        // blind from a page that is going away.
        void fetch(
          `${base}/api/item-locks/${encodeURIComponent(collection)}/${encodeURIComponent(item)}/lock/release`,
          {
            method: 'POST',
            keepalive: true,
            credentials: token ? 'omit' : 'include',
            headers: token ? { Authorization: `Bearer ${token}` } : {}
          }
        ).catch(() => {})
      } catch {
        /* best effort — the TTL still frees it */
      }
    }
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted && offScreenReleasedRef.current) {
        offScreenReleasedRef.current = false
        void acquire()
      }
    }
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [enabled, collection, item, client, stopHeartbeat, acquire])

  // #2131: the same person's other window (a popped-out record, another tab)
  // just released the lock while this one still edits — take it straight back.
  useRecordTabsSignal(userId, 'lock-released', collection, item, () => {
    if (enabled && acquiredRef.current) void acquire()
  })

  // ── Lock handoff (#286) ─────────────────────────────────────────────────
  // Holder side: a live 'lock:requested' for THIS record shows a toast with
  // Release / Decline. Requester side: 'lock:response' release → auto-acquire.
  const realtime = useOptionalRealtime()
  const [requesting, setRequesting] = useState(false)
  const requestLock = useCallback(async () => {
    if (!collection || !item) return
    setRequesting(true)
    try {
      await client.request(post(`/item-locks/${collection}/${item}/lock/request`, {}))
      toast.success('Asked the current editor to release the lock')
    } catch {
      toast.error('Could not send the lock request')
    } finally {
      setRequesting(false)
    }
  }, [client, collection, item])

  useEffect(() => {
    if (!realtime || !collection || !item) return
    const unsubReq = realtime.on('lock:requested', (p: any) => {
      if (p?.collection !== collection || String(p?.item) !== String(item)) return
      if (!acquiredRef.current) return
      const requester = p?.from ?? {}
      toast(`${requester.name ?? 'Someone'} is asking you to release this record`, {
        duration: 30_000,
        action: {
          label: 'Release',
          onClick: () => {
            stopHeartbeat()
            acquiredRef.current = false
            setAcquired(false)
            client
              .request(
                post(`/item-locks/${collection}/${item}/lock/respond`, {
                  to: requester.id,
                  action: 'release'
                })
              )
              .then(() => toast.success('Lock released'))
              .catch(() => toast.error('Failed to release the lock'))
          }
        },
        cancel: {
          label: 'Keep editing',
          onClick: () => {
            client
              .request(
                post(`/item-locks/${collection}/${item}/lock/respond`, {
                  to: requester.id,
                  action: 'decline'
                })
              )
              .catch(() => {})
          }
        }
      })
    })
    const unsubResp = realtime.on('lock:response', (p: any) => {
      if (p?.collection !== collection || String(p?.item) !== String(item)) return
      if (acquiredRef.current) return
      if (p?.action === 'release') {
        toast.success(`${p?.from?.name ?? 'The editor'} released the lock — it's yours`)
        void acquire()
      } else {
        toast.warning(
          `${p?.from?.name ?? 'The editor'} is keeping the lock${p?.note ? `: "${p.note}"` : ''}`
        )
      }
    })
    // Wait queue (#10): my turn → auto-acquire; someone queued behind me → nudge.
    const unsubAvail = realtime.on('lock:available', (p: any) => {
      if (p?.collection !== collection || String(p?.item) !== String(item)) return
      if (acquiredRef.current) return
      toast.success('Your turn — the edit lock is yours')
      setMyPosition(null)
      void acquire()
    })
    const unsubQueued = realtime.on('lock:queued', (p: any) => {
      if (p?.collection !== collection || String(p?.item) !== String(item)) return
      if (acquiredRef.current)
        toast(`${p?.user_name ?? 'Someone'} is waiting to edit this record`, { duration: 8000 })
      void refreshLockInfo()
    })
    return () => {
      unsubReq()
      unsubResp()
      unsubAvail()
      unsubQueued()
    }
  }, [realtime, collection, item, client, acquire, stopHeartbeat, refreshLockInfo])

  const joinQueue = useCallback(async () => {
    if (!collection || !item) return
    setJoining(true)
    try {
      const r = await client.request<{ data: { position?: number } }>(
        post(`/item-locks/${collection}/${item}/lock/queue`, {})
      )
      const pos = (r as { data?: { position?: number } })?.data?.position
      setMyPosition(typeof pos === 'number' ? pos : 1)
      toast.success('You are in line — the lock comes to you automatically when it frees up')
      void refreshLockInfo()
    } catch {
      toast.error('Could not join the queue')
    } finally {
      setJoining(false)
    }
  }, [client, collection, item, refreshLockInfo])
  const leaveQueue = useCallback(async () => {
    if (!collection || !item) return
    try {
      await client.request(del(`/item-locks/${collection}/${item}/lock/queue`))
      setMyPosition(null)
      void refreshLockInfo()
    } catch {
      /* noop */
    }
  }, [client, collection, item, refreshLockInfo])
  const saveNote = useCallback(
    async (note: string) => {
      if (!collection || !item || !acquiredRef.current) return
      setMyNote(note)
      try {
        await client.request(post(`/item-locks/${collection}/${item}/lock/note`, { note }))
      } catch {
        /* best effort — the note is a courtesy */
      }
    },
    [client, collection, item]
  )

  /** Holder gives the lock up without leaving the record. The server hands it
   *  to whoever is first in the wait queue (same path as closing the tab). */
  const release = useCallback(async () => {
    if (!collection || !item || !acquiredRef.current) return
    setReleasing(true)
    stopHeartbeat()
    acquiredRef.current = false
    setAcquired(false)
    try {
      await client.request(del(`/item-locks/${collection}/${item}/lock`))
      setReleased(true)
      setMyNote('')
      toast.success('Lock released — anyone can edit this record now')
    } catch {
      toast.error('Failed to release the lock')
      // Best effort to get back to a known state: re-acquire.
      void acquire()
    } finally {
      setReleasing(false)
    }
  }, [client, collection, item, stopHeartbeat, acquire])
  /** After a manual release: take the lock back (the pill's "Lock again", or
   *  the form's next real edit). A 409 lands in lockHolder like any acquire. */
  const relock = useCallback(async () => {
    if (acquiredRef.current) return true
    const ok = await acquire()
    if (ok) toast.success('You hold the edit lock again')
    return ok
  }, [acquire])

  const takeOver = useCallback(async () => {
    if (!collection || !item) return
    setTakingOver(true)
    try {
      // Takeover permission (#256): the force route enforces WHO may — admins
      // always, plus roles in settings.lock_takeover_roles. A 403 explains.
      await client.request(post(`/item-locks/${collection}/${item}/lock/force`, {}))
      toast.success('You now hold the edit lock')
      // The server already gave us the lock: refreshing it clears the holder
      // (so the read-only state lifts) and starts the heartbeat.
      await acquire()
    } catch (err) {
      const msg =
        (err as { response?: { error?: string }; message?: string })?.response?.error ??
        'Failed to take over the lock'
      toast.error(msg)
      // Refused for this role: stop offering a button that can only fail.
      if ((err as { status?: number })?.status === 403)
        setLockHolder((cur) => (cur ? { ...cur, may_take_over: false } : cur))
    } finally {
      setTakingOver(false)
    }
  }, [client, collection, item, acquire])

  return {
    lockHolder,
    acquired,
    isReadOnly: !!lockHolder,
    takeOver,
    takingOver,
    isAdmin,
    requestLock,
    requesting,
    queue,
    myPosition,
    joinQueue,
    leaveQueue,
    joining,
    myNote,
    saveNote,
    release,
    releasing,
    released,
    relock,
    claim
  }
}

/**
 * Holder side of #10, in the header tool pill: a compact lock glyph (amber
 * dot when someone is waiting) whose popover holds the intent note and the
 * wait list. Lives beside the other record tools — never in the form body.
 */
export function LockHolderButton({
  note,
  onSave,
  waiting,
  onRelease,
  releasing,
  released,
  onRelock
}: {
  note: string
  onSave: (note: string) => void
  waiting: LockQueueEntry[]
  /** Give the lock up now (any time — no waiter required). */
  onRelease?: () => void
  releasing?: boolean
  /** The holder released it and has not edited since: unlocked glyph + "Lock again". */
  released?: boolean
  onRelock?: () => void
}) {
  const [draft, setDraft] = useState(note)
  useEffect(() => setDraft(note), [note])
  const commit = () => {
    if (draft.trim() !== note) onSave(draft.trim())
  }
  if (released) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type='button'
            aria-label='You released the edit lock — lock it again'
            title='Lock released — anyone can edit this record'
            data-lock-released
            className='relative inline-flex h-8 w-8 items-center justify-center text-slate-400 transition-colors hover:bg-accent hover:text-accent-foreground dark:text-slate-500'
          >
            <LockOpen className='h-4 w-4' strokeWidth={2} />
          </button>
        </PopoverTrigger>
        <PopoverContent align='end' sideOffset={6} className='w-[300px] p-3'>
          <p className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
            You released the edit lock
          </p>
          <p className='mt-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
            Anyone can edit this record now. Your next edit locks it again — or lock it now.
          </p>
          <Button
            type='button'
            size='sm'
            className='mt-2 h-7 w-full text-[12px]'
            onClick={onRelock}
            data-lock-relock
          >
            <Lock className='mr-1.5 h-3.5 w-3.5' /> Lock again
          </Button>
        </PopoverContent>
      </Popover>
    )
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='You hold the edit lock — add a note for others'
          title={
            waiting.length > 0
              ? `You hold the edit lock · ${waiting.length} waiting`
              : 'You hold the edit lock'
          }
          data-lock-holder
          className='relative inline-flex h-8 w-8 items-center justify-center text-[#0e7490] transition-colors hover:bg-accent hover:text-accent-foreground dark:text-nvr-cyan'
        >
          <Lock className='h-4 w-4' strokeWidth={2} />
          {waiting.length > 0 && (
            <span className='absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-500 ring-2 ring-background' />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' sideOffset={6} className='w-[300px] p-3'>
        <p className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          You hold the edit lock
        </p>
        <p className='mt-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
          Others see this record read-only. A note tells them what you’re doing.
        </p>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 300))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder='“editing lines, ~15 min”'
          aria-label='Lock note'
          className='mt-2 h-7 w-full rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
        />
        {waiting.length > 0 && (
          <div className='mt-2 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'>
            <span className='font-semibold'>{waiting.length} waiting for the lock:</span>{' '}
            {waiting.map((w) => w.name ?? 'someone').join(', ')}
          </div>
        )}
        {onRelease && (
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='mt-2 h-7 w-full text-[12px]'
            onClick={onRelease}
            disabled={releasing}
            data-lock-release
          >
            <LockOpen className='mr-1.5 h-3.5 w-3.5' />
            {releasing
              ? 'Releasing…'
              : waiting.length > 0
                ? `Release lock to ${waiting[0]?.name ?? 'the next person'}`
                : 'Release lock'}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function ItemLockBanner({
  lockHolder,
  onTakeOver,
  takingOver,
  isAdmin,
  onRequestLock,
  requesting,
  queue,
  myPosition,
  onJoinQueue,
  onLeaveQueue,
  joining,
  noun = 'this item',
  readOnlyText = 'fields are read-only'
}: {
  /** What is being edited ("this video"). */
  noun?: string
  /** What being locked out means here ("the editor is read-only"). */
  readOnlyText?: string
  lockHolder: LockHolder | null
  onTakeOver: () => void
  takingOver: boolean
  isAdmin?: boolean
  onRequestLock?: () => void
  requesting?: boolean
  queue?: LockQueueEntry[]
  myPosition?: number | null
  onJoinQueue?: () => void
  onLeaveQueue?: () => void
  joining?: boolean
}) {
  if (!lockHolder) return null
  const name = lockHolder.locked_by_name || 'Another user'
  const ahead = queue?.length ?? 0
  return (
    <div
      className='mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100'
      data-lock-banner
    >
      <Lock className='h-4 w-4 shrink-0 text-amber-500' />
      <span className='min-w-0 flex-1'>
        <span className='font-medium'>{name}</span> is editing {noun} — {readOnlyText}
        {lockHolder.idle_minutes != null && lockHolder.idle_minutes >= 2 && (
          <span
            className='ml-1.5 rounded bg-amber-100 px-1 py-px text-[10px] font-semibold text-amber-700 dark:bg-amber-500/20 dark:text-amber-200'
            data-lock-holder-idle
            data-tip='How long since they last touched anything — they may have stepped away'
          >
            idle {lockHolder.idle_minutes}m
          </span>
        )}{' '}
        until the lock is released.
        {lockHolder.note && (
          <span className='mt-0.5 block text-[12.5px] text-amber-800/90 dark:text-amber-200/90'>
            “{lockHolder.note}”
          </span>
        )}
        {ahead > 0 && myPosition == null && (
          <span className='mt-0.5 block text-[11.5px] text-amber-700/80 dark:text-amber-300/80'>
            {ahead} {ahead === 1 ? 'person is' : 'people are'} already waiting.
          </span>
        )}
      </span>
      {onJoinQueue &&
        (myPosition != null ? (
          <Button
            size='sm'
            variant='outline'
            className='h-7 shrink-0 border-amber-300 bg-white text-[12px] text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/15'
            onClick={onLeaveQueue}
            data-lock-queue-leave
          >
            You’re #{myPosition} in line · Leave
          </Button>
        ) : (
          <Button
            size='sm'
            variant='outline'
            className='h-7 shrink-0 border-amber-300 bg-white text-[12px] text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/15'
            onClick={onJoinQueue}
            disabled={joining}
            data-lock-queue-join
          >
            {joining ? 'Joining…' : 'Ask to be next'}
          </Button>
        ))}
      {onRequestLock && (
        <Button
          size='sm'
          variant='outline'
          className='h-7 shrink-0 border-amber-300 bg-white text-[12px] text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/15'
          onClick={onRequestLock}
          disabled={requesting}
        >
          {requesting ? 'Asking…' : 'Ask them to wrap up'}
        </Button>
      )}
      {
        // Admins always; other roles only when the server says they may (the
        // takeover-role allowlist, #256) — unknown = offered, and a 403 then
        // hides it. A Take over that can only fail was a dead end.
        (isAdmin || lockHolder.may_take_over !== false) && (
          <Button
            size='sm'
            variant='outline'
            className={
              isAdmin
                ? 'h-7 shrink-0 border-amber-300 bg-white text-[12px] text-amber-800 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-500/15'
                : 'h-7 shrink-0 border-amber-200 bg-white/60 text-[12px] text-amber-700/80 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-transparent dark:text-amber-200/80 dark:hover:bg-amber-500/15'
            }
            onClick={onTakeOver}
            disabled={takingOver}
          >
            {takingOver ? 'Taking over…' : 'Take over'}
          </Button>
        )
      }
    </div>
  )
}
