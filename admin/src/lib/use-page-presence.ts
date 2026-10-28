import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import type { Socket } from 'socket.io-client'
import { useAuth } from '@/lib/auth'
import { getSocket } from '@/lib/socket'

/**
 * Reports which admin page the current user is on (presence map feed).
 * Rides the app's one socket (getSocket) and re-emits on route change — it used to open a second
 * connection per tab when the browser had no SharedWorker.
 *
 * On the shared socket (#2475) the ping rides the browser's one connection: the worker keeps
 * each tab's last page and reports the tab the person used last.
 */

export function usePagePresence() {
  const { user } = useAuth()
  const location = useLocation()
  const socketRef = useRef<Socket | null>(null)
  const readyRef = useRef(false)
  const pathRef = useRef(location.pathname)
  pathRef.current = location.pathname

  useEffect(() => {
    if (!user) return
    // getSocket() signs itself in (the worker, or this tab's own socket).
    const socket = getSocket()
    socketRef.current = socket

    const onAuth = () => {
      readyRef.current = true
      socket.emit('page:at', { path: pathRef.current, app: 'admin' })
    }
    const onDisconnect = () => {
      readyRef.current = false
    }
    socket.on('auth:ok', onAuth)
    socket.on('disconnect', onDisconnect)
    // Attached to a connection that is already up: say where this tab is now (before its
    // sign-in the server ignores it, and auth:ok says it again).
    if (socket.connected) onAuth()

    return () => {
      readyRef.current = false
      socketRef.current = null
      socket.off('auth:ok', onAuth)
      socket.off('disconnect', onDisconnect)
    }
  }, [user])

  useEffect(() => {
    if (readyRef.current)
      socketRef.current?.emit('page:at', { path: location.pathname, app: 'admin' })
  }, [location.pathname])
}
