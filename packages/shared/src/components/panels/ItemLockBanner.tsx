import { Lock } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { del, post } from '../../lib/commands'
import { Button } from '../ui/button'

const HEARTBEAT_MS = 60_000

export interface LockHolder {
  locked_by: string
  locked_by_name: string | null
}

export function useItemLock(
  collection: string | undefined,
  item: string | undefined,
  enabled: boolean
) {
  const client = useNivaroClient()
  const { isAdmin } = useItemEditAuth()
  const [lockHolder, setLockHolder] = useState<LockHolder | null>(null)
  const [acquired, setAcquired] = useState(false)
  const [takingOver, setTakingOver] = useState(false)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const acquiredRef = useRef(false)

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
    }
  }, [])

  const acquire = useCallback(async () => {
    if (!collection || !item) return false
    try {
      await client.request(post(`/item-locks/${collection}/${item}/lock`, {}))
      acquiredRef.current = true
      setAcquired(true)
      setLockHolder(null)
      stopHeartbeat()
      heartbeatRef.current = setInterval(() => {
        client.request(post(`/item-locks/${collection}/${item}/heartbeat`, {})).catch(() => {})
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
      if (status === 409 && body?.locked_by) {
        acquiredRef.current = false
        setAcquired(false)
        setLockHolder({
          locked_by: body.locked_by,
          locked_by_name: body.locked_by_name ?? null
        })
      }
      return false
    }
  }, [client, collection, item, stopHeartbeat])

  useEffect(() => {
    if (!enabled || !collection || !item) return
    acquire()
    return () => {
      stopHeartbeat()
      if (acquiredRef.current) {
        acquiredRef.current = false
        client.request(del(`/item-locks/${collection}/${item}/lock`)).catch(() => {})
      }
    }
  }, [enabled, collection, item, acquire, client, stopHeartbeat])

  const takeOver = useCallback(async () => {
    if (!collection || !item) return
    setTakingOver(true)
    try {
      await client.request(del(`/item-locks/${collection}/${item}/lock?force=1`))
      const ok = await acquire()
      if (ok) toast.success('You now hold the edit lock')
      else toast.error('Failed to take over the lock')
    } catch {
      toast.error('Failed to take over the lock')
    } finally {
      setTakingOver(false)
    }
  }, [client, collection, item, acquire])

  return { lockHolder, acquired, isReadOnly: !!lockHolder, takeOver, takingOver, isAdmin }
}

export function ItemLockBanner({
  lockHolder,
  onTakeOver,
  takingOver,
  isAdmin
}: {
  lockHolder: LockHolder | null
  onTakeOver: () => void
  takingOver: boolean
  isAdmin?: boolean
}) {
  if (!lockHolder) return null
  const name = lockHolder.locked_by_name || 'Another user'
  return (
    <div className='mb-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900'>
      <Lock className='h-4 w-4 shrink-0 text-amber-500' />
      <span className='flex-1'>
        <span className='font-medium'>{name}</span> is editing this item — fields are read-only
        until the lock is released.
      </span>
      {isAdmin && (
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
