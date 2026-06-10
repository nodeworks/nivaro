// Consolidates all FastifyInstance augmentations from plugins so that
// extensions importing loader.ts see app.io, app.redis, app.cron, app.inngest
// without needing to import each plugin individually.
import type { Inngest } from 'inngest'
import type { Redis } from 'ioredis'
import type { Server as SocketIOServer } from 'socket.io'
import type { CronManager } from './plugins/cron.js'

declare module 'fastify' {
  interface FastifyInstance {
    io: SocketIOServer
    redis: Redis
    inngest: Inngest
    cron: CronManager
  }
}
