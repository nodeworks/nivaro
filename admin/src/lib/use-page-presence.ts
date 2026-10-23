import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { io, type Socket } from 'socket.io-client'
import { useAuth } from '@/lib/auth'
import { getSocket, mintWsToken, usesWorkerSocket } from '@/lib/socket'
import { SOCKET_TRANSPORT_OPTIONS } from '@/lib/socket-transport'

/**
 * Reports which admin page the current user is on (presence map feed).
 * One lightweight socket for the whole session; re-emits on route change.
 *
 * On the shared socket (#2475) the ping rides the browser's one connection: the worker keeps
 * each tab's last page and reports the tab the person used last.
 */

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

export function usePagePresence() {
  const { user } = useAuth()
  const location = useLocation()
  const socketRef = useRef<Socket | null>(null)
  const readyRef = useRef(false)
  const pathRef = useRef(location.pathname)
  pathRef.current = location.pathname

  useEffect(() => {
    if (!user) return
    const shared = usesWorkerSocket()
    const socket = shared
      ? getSocket()
      : io(API_URL, { ...SOCKET_TRANSPORT_OPTIONS, withCredentials: true })
    socketRef.current = socket

    const onConnect = async () => {
      let token = user.static_token ?? null
      if (!token) {
        token = await mintWsToken()
      }
      if (token) socket.emit('auth', { token })
    }
    const onAuth = () => {
      readyRef.current = true
      socket.emit('page:at', { path: pathRef.current, app: 'admin' })
    }
    const onDisconnect = () => {
      readyRef.current = false
    }
    // The shared socket signs itself in (the worker does); a tab-local one does it here.
    if (!shared) socket.on('connect', onConnect)
    socket.on('auth:ok', onAuth)
    socket.on('disconnect', onDisconnect)
    // Attached to a connection that is already up: say where this tab is now.
    if (shared && socket.connected) onAuth()

    return () => {
      readyRef.current = false
      socketRef.current = null
      socket.off('connect', onConnect)
      socket.off('auth:ok', onAuth)
      socket.off('disconnect', onDisconnect)
      if (!shared) socket.disconnect()
    }
  }, [user])

  useEffect(() => {
    if (readyRef.current)
      socketRef.current?.emit('page:at', { path: location.pathname, app: 'admin' })
  }, [location.pathname])
}
