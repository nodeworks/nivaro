import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { Redis } from 'ioredis'
import { config } from '../config.js'

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis
  }
}

export const redisPlugin = fp(async (app: FastifyInstance) => {
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableReadyCheck: true
  })

  redis.on('error', (err: Error) => app.log.error({ err }, 'Redis error'))
  redis.on('connect', () => app.log.info('Redis connected'))

  await redis.connect()

  app.decorate('redis', redis)
  app.addHook('onClose', async () => {
    await redis.quit()
  })
})
