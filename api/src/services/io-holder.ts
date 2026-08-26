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

/** The Fastify app itself, for services that need in-process injects
 *  (addendum auto-PDF) with no request in scope. Same lifecycle as _io. */
// biome-ignore lint/suspicious/noExplicitAny: avoids a fastify type import in a leaf module
let _app: any = null
// biome-ignore lint/suspicious/noExplicitAny: see above
export function setAppRef(app: any): void {
  _app = app
}
// biome-ignore lint/suspicious/noExplicitAny: see above
export function getApp(): any {
  return _app
}
