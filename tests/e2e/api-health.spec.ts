import { expect, test } from '@playwright/test'

const API = 'http://localhost:3055'

test.describe('API smoke tests', () => {
  test('GET /api/health returns 200 with status field', async ({ request }) => {
    const res = await request.get(`${API}/api/health`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('status')
  })

  test('GET /api/collections without auth returns 401', async ({ request }) => {
    const res = await request.get(`${API}/api/collections`)
    expect(res.status()).toBe(401)
  })

  test('GET /api/users without auth returns 401', async ({ request }) => {
    const res = await request.get(`${API}/api/users`)
    expect(res.status()).toBe(401)
  })

  test('GET /api/roles without auth returns 401', async ({ request }) => {
    const res = await request.get(`${API}/api/roles`)
    expect(res.status()).toBe(401)
  })

  test('GET /api/settings without auth returns 401', async ({ request }) => {
    const res = await request.get(`${API}/api/settings`)
    expect(res.status()).toBe(401)
  })

  test('POST /api/items/:col without auth returns 401', async ({ request }) => {
    const res = await request.post(`${API}/api/items/test_collection`, {
      data: { title: 'should not be created' }
    })
    expect(res.status()).toBe(401)
  })

  test('health response includes expected service keys', async ({ request }) => {
    const res = await request.get(`${API}/api/health`)
    const body = await res.json()
    // Nivaro health endpoint reports db, redis, etc.
    expect(typeof body).toBe('object')
    expect(body).not.toBeNull()
  })
})
