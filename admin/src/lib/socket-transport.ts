import type { ManagerOptions, SocketOptions } from 'socket.io-client'

/**
 * #1672 — websocket first; when the upgrade fails (a proxy strips it), the same connect attempt
 * falls through to HTTP long-polling. Every socket in the admin uses these options. Polling
 * needs sticky sessions behind a load balancer; a server with SOCKET_POLLING=off refuses it and
 * the shared socket (lib/socket.ts) falls back to the read-only SSE stream instead.
 */
export const SOCKET_TRANSPORT_OPTIONS: Partial<ManagerOptions & SocketOptions> = {
  transports: ['websocket', 'polling'],
  tryAllTransports: true
}
