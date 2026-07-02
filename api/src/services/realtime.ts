import type { Server as SocketIOServer } from 'socket.io'

/**
 * Best-effort broadcast that a record in `collection` changed. Consumers
 * (e.g. QueueDetail.tsx) join `collection:${collection}` rooms for the
 * collections their current view depends on and invalidate on this event —
 * this function has no knowledge of queues or any other specific consumer.
 */
export function broadcastCollectionUpdate(
  io: SocketIOServer | undefined,
  collection: string,
  item: string | number
): void {
  io?.to(`collection:${collection}`).emit('collection:update', { collection, item })
}
