import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { io, type Socket } from 'socket.io-client'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/**
 * Reports which admin page the current user is on (presence map feed).
 * One lightweight socket for the whole session; re-emits on route change.
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
    const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })
    socketRef.current = socket

    socket.on('connect', async () => {
      let token = user.static_token ?? null
      if (!token) {
        try {
          const r = await api.get<{ data?: { token?: string }; token?: string }>('/auth/ws-token')
          token = r.data.data?.token ?? r.data.token ?? null
        } catch {
          token = null
        }
      }
      if (token) socket.emit('auth', { token })
    })
    socket.on('auth:ok', () => {
      readyRef.current = true
      socket.emit('page:at', { path: pathRef.current })
    })
    socket.on('disconnect', () => {
      readyRef.current = false
    })

    return () => {
      readyRef.current = false
      socketRef.current = null
      socket.disconnect()
    }
  }, [user])

  useEffect(() => {
    if (readyRef.current) socketRef.current?.emit('page:at', { path: location.pathname })
  }, [location.pathname])
}
