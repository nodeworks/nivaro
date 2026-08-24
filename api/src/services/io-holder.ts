import type { Server as SocketIOServer } from 'socket.io'

/**
 * Global Socket.io accessor for services with no Fastify app in scope
 * (job-runs, monitors, journal). Set once at boot by server.ts after the
 * socketio plugin registers. Null before boot completes — every consumer
 * treats emit as best-effort.
 */
let _io: SocketIOServer | null = null
export function setIo(io: SocketIOServer): void {
  _io = io
}
export function getIo(): SocketIOServer | null {
  return _io
}
