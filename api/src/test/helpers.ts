import Fastify, { type FastifyInstance } from 'fastify'
import type { User } from '../types.js'

export async function buildTestApp(
  routes: (app: FastifyInstance) => Promise<void>
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await routes(app)
  await app.ready()
  return app
}

export function makeAdminUser(): User {
  return {
    id: 'test-admin-id',
    first_name: 'Admin',
    last_name: 'User',
    email: 'admin@test.com',
    external_id: null,
    role: 'admin-role-id',
    status: 'active',
    static_token: null,
    last_access: null,
    last_page: null,
    preferences: null,
    current_workspace: null,
    manager_id: null,
    delegate_id: null,
    delegate_expires_at: null,
    is_out_of_office: false,
    created_at: new Date(),
    updated_at: new Date(),
  }
}

export function makeRegularUser(overrides: Partial<User> = {}): User {
  return {
    id: 'test-user-id',
    first_name: 'Regular',
    last_name: 'User',
    email: 'user@test.com',
    external_id: null,
    role: 'regular-role-id',
    status: 'active',
    static_token: null,
    last_access: null,
    last_page: null,
    preferences: null,
    current_workspace: null,
    manager_id: null,
    delegate_id: null,
    delegate_expires_at: null,
    is_out_of_office: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  }
}
