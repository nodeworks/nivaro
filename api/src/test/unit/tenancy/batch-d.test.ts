import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chaosRefusal } from '../../../services/chaos/gate.js'
import { importDrainMode } from '../../../services/import-handoff.js'
import { filesFallbackDir } from '../../../services/storage/fallback.js'
import { bustTeamsBotConfig, getTeamsBotConfig } from '../../../services/teams-bot/config.js'

// Batch D (infrastructure, storage, chaos, imports, exports, Teams bot, trackers): every site is
// multiTenant. Cloud and self-hosted behave as before; a shared Hub deployment behaves like cloud.
const SELF: NodeJS.ProcessEnv = {}
const CLOUD: NodeJS.ProcessEnv = { CLOUD_META_DB_URL: 'postgres://meta' }
const SHARED: NodeJS.ProcessEnv = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example.com',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
}

describe('batch D: classified cloud-flag sites', () => {
  it('chaos gate (T5): refused on cloud and shared, open on self-hosted', () => {
    expect(chaosRefusal(SELF)).toBeNull()
    // Final review (rest) Minor 2: the reason names the deployment kind, not "cloud mode" (a Hub
    // shared deployment is not cloud).
    const why =
      'Chaos drills never run on a multi-tenant deployment (cloud mode or a Hub shared deployment)'
    expect(chaosRefusal(CLOUD)).toBe(why)
    expect(chaosRefusal(SHARED)).toBe(why)
  })

  it('import hand-off drain (T4): off on cloud; a shared deployment drains per app', () => {
    expect(importDrainMode(CLOUD)).toBe('off')
    expect(importDrainMode(SHARED)).not.toBe('off')
    expect(importDrainMode({ ...SELF, IMPORT_WORKER: 'on' })).not.toBe('off')
  })

  it('file fallback folder (T4): ignored on cloud and shared', () => {
    const dir = { FILES_FALLBACK_DIR: '/mnt/source' }
    expect(filesFallbackDir({ ...SELF, ...dir })).toBe('/mnt/source')
    expect(filesFallbackDir({ ...CLOUD, ...dir })).toBeNull()
    expect(filesFallbackDir({ ...SHARED, ...dir })).toBeNull()
  })

  describe('Teams bot reason stays "cloud" on shared (T4)', () => {
    const saved = { ...process.env }
    beforeEach(() => bustTeamsBotConfig())
    afterEach(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
      bustTeamsBotConfig()
    })

    it('cloud', async () => {
      process.env.CLOUD_META_DB_URL = 'postgres://meta'
      const c = await getTeamsBotConfig()
      expect(c.enabled).toBe(false)
      expect(c.reason).toBe('cloud')
    })

    it('shared', async () => {
      delete process.env.CLOUD_META_DB_URL
      Object.assign(process.env, SHARED)
      const c = await getTeamsBotConfig()
      expect(c.enabled).toBe(false)
      expect(c.reason).toBe('cloud')
    })
  })
})
