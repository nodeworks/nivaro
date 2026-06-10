import fastifyCookie from '@fastify/cookie'
import type { FastifySessionObject } from '@fastify/session'
import fastifySession from '@fastify/session'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { config } from '../config.js'

function buildRedisStore(redis: Redis) {
  return {
    get(sid: string, callback: (err: unknown, session: FastifySessionObject | null) => void) {
      redis.get(`sess:${sid}`).then(
        (raw) => callback(null, raw ? (JSON.parse(raw) as FastifySessionObject) : null),
        (err) => callback(err, null)
      )
    },
    set(sid: string, session: FastifySessionObject, callback: (err?: unknown) => void) {
      redis.setex(`sess:${sid}`, config.SESSION_TTL, JSON.stringify(session)).then(
        () => callback(),
        (err) => callback(err)
      )
    },
    destroy(sid: string, callback: (err?: unknown) => void) {
      redis.del(`sess:${sid}`).then(
        () => callback(),
        (err) => callback(err)
      )
    }
  }
}

export async function registerSession(app: FastifyInstance) {
  await app.register(fastifyCookie)
  await app.register(fastifySession, {
    secret: config.SESSION_SECRET,
    cookieName: 'nivaro_session',
    cookie: {
      secure: config.COOKIE_SECURE,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: config.SESSION_TTL * 1000
    },
    store: buildRedisStore(app.redis) as Parameters<typeof fastifySession>[1]['store'],
    rolling: true,
    saveUninitialized: false
  })
}
