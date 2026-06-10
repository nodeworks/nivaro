import { Lock } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

const API_URL = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env
  ?.VITE_API_URL ?? 'http://localhost:3055') as string

const HEARTBEAT_MS = 60_000

export interface LockHolder {
  locked_by: string
  locked_by_name: string | null
}

/**
 * Tries to acquire an edit lock for the given item on mount. While held, sends
 * a heartbeat every 60s and releases the lock on unmount. If another user
 * holds the lock, `lockHolder` is set and the caller should render read-only.
 */
export function useItemLock(
  collection: string | undefined,
  item: string | undefined,
  enabled: boolean
) {
  const { user } = useAuth()
  const [lockHolder, setLockHolder] = useState<LockHolder | null>(null)
  const [acquired, setAcquired] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const acquiredRef = useRef(false)
  const socketRef = useRef<Socket | null>(null)

  const lockUrl = `/item-locks/${collection}/${item}/lock`

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
    }
  }, [])

  const acquire = useCallback(async () => {
    try {
      await api.post(lockUrl)
      acquiredRef.current = true
      setAcquired(true)
      setLockHolder(null)
      stopHeartbeat()
      heartbeatRef.current = setInterval(() => {
        api.post(`/item-locks/${collection}/${item}/heartbeat`).catch(() => {
          /* non-fatal — server expires stale locks on its own */
        })
      }, HEARTBEAT_MS)
      return true
    } catch (err: unknown) {
      const resp = (err as { response?: { status?: number; data?: LockHolder } })?.response
      if (resp?.status === 409 && resp.data) {
        acquiredRef.current = false
        setAcquired(false)
        setLockHolder({
          locked_by: resp.data.locked_by,
          locked_by_name: resp.data.locked_by_name ?? null
        })
      }
      return false
    }
  }, [collection, item, lockUrl, stopHeartbeat])

  // biome-ignore lint/correctness/useExhaustiveDependencies: acquire/stopHeartbeat are stable per collection+item; re-running on identity change would thrash the lock
  useEffect(() => {
    if (!enabled || !collection || !item) return

    acquire()

    // Live-update the banner when the holder releases the lock.
    const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })
    socketRef.current = socket
    socket.on('connect', () => {
      const token = user?.static_token
      if (token) socket.emit('auth', { token })
      // Lock events are emitted to the presence room for this item
      socket.emit('presence:join', { roomId: `item:${collection}:${item}` })
    })
    const onLockEvent = (payload: { collection?: string; item?: string; locked?: boolean }) => {
      if (
        payload?.collection === collection &&
        String(payload?.item) === String(item) &&
        payload?.locked === false &&
        !acquiredRef.current
      ) {
        acquire()
      }
    }
    socket.on('item-lock', onLockEvent)

    return () => {
      stopHeartbeat()
      socket.disconnect()
      socketRef.current = null
      if (acquiredRef.current) {
        acquiredRef.current = false
        api.delete(`/item-locks/${collection}/${item}/lock`).catch(() => {
          /* lock expires server-side if release fails */
        })
      }
    }
  }, [enabled, collection, item])

  const takeOver = useCallback(async () => {
    if (!collection || !item) return
    setTakingOver(true)
    try {
      await api.delete(`${lockUrl}?force=1`)
      const ok = await acquire()
      if (ok) toast.success('You now hold the edit lock')
      else toast.error('Failed to take over the lock')
    } catch {
      toast.error('Failed to take over the lock')
    } finally {
      setTakingOver(false)
    }
  }, [collection, item, lockUrl, acquire])

  return {
    /** Another user holds the lock — render read-only. */
    lockHolder,
    /** We hold the lock and may edit. */
    acquired,
    isReadOnly: !!lockHolder,
    takeOver,
    takingOver
  }
}

/** Amber banner shown when another user is editing the item. */
export function ItemLockBanner({
  lockHolder,
  onTakeOver,
  takingOver
}: {
  lockHolder: LockHolder | null
  onTakeOver: () => void
  takingOver: boolean
}) {
  const { user } = useAuth()
  if (!lockHolder) return null

  const name = lockHolder.locked_by_name || 'Another user'

  return (
    <div className='mb-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900'>
      <Lock className='h-4 w-4 shrink-0 text-amber-500' />
      <span className='flex-1'>
        <span className='font-medium'>{name}</span> is editing this item — fields are read-only
        until the lock is released.
      </span>
      {user?.is_admin && (
        <Button
          size='sm'
          variant='outline'
          className='h-7 shrink-0 border-amber-300 bg-white text-[12px] text-amber-800 hover:bg-amber-100'
          onClick={onTakeOver}
          disabled={takingOver}
        >
          {takingOver ? 'Taking over…' : 'Take over'}
        </Button>
      )}
    </div>
  )
}
