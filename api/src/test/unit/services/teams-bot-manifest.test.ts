import { describe, expect, it } from 'vitest'
import { buildManifest, buildTeamsPackage } from '../../../services/teams-bot/manifest.js'

const input = {
  appId: '11111111-2222-3333-4444-555555555555',
  name: 'Nivaro',
  shortDescription: 'short',
  fullDescription: 'full',
  publicHost: 'nivaro.example.com',
  developerUrl: 'https://nivaro.example.com'
}

// Stored zip: file names sit uncompressed in the central directory.
const zipNames = (z: Buffer): string[] => {
  const names: string[] = []
  for (let i = 0; i + 46 <= z.length; i++) {
    if (z.readUInt32LE(i) === 0x02014b50) {
      const n = z.readUInt16LE(i + 28)
      names.push(z.subarray(i + 46, i + 46 + n).toString())
    }
  }
  return names
}

describe('teams app manifest', () => {
  it('manifest has the app id, both scopes and the host as validDomain', () => {
    const m = buildManifest(input) as {
      id: string
      manifestVersion: string
      validDomains: string[]
      webApplicationInfo?: unknown
      bots: Array<
        Record<string, unknown> & {
          scopes: string[]
          botId: string
          commandLists: Array<{ scopes: string[]; commands: unknown[] }>
        }
      >
    }
    expect(m.id).toBe(input.appId)
    expect(m.manifestVersion).toBe('1.29')
    expect(m.bots[0].botId).toBe(input.appId)
    expect(m.bots[0].scopes).toEqual(['personal', 'team'])
    expect(m.bots[0].commandLists.map((c) => c.scopes[0])).toEqual(['personal', 'team'])
    expect(m.bots[0].commandLists[0].commands.length).toBe(7)
    expect(m.bots[0].isNotificationOnly).toBe(false)
    expect(m.bots[0].supportsFiles).toBe(false)
    expect('supportsChannelFeatures' in m.bots[0]).toBe(false)
    expect(m.validDomains).toEqual(['nivaro.example.com'])
    expect(m.webApplicationInfo).toBeUndefined()
  })

  it('manifest version is plain x.y.z even for prerelease builds', () => {
    const v = (version?: string) =>
      (buildManifest({ ...input, version }) as { version: string }).version
    expect(v('0.3.35-rc1')).toBe('0.3.35')
    expect(v('0.0.0-dev')).toBe('0.0.0')
    expect(v('dev')).toBe('1.0.0')
    expect(v(undefined)).toBe('1.0.0')
  })

  it('package zip contains manifest.json, color.png, outline.png', () => {
    const z = buildTeamsPackage(input)
    expect(zipNames(z).sort()).toEqual(['color.png', 'manifest.json', 'outline.png'])
  })
})
