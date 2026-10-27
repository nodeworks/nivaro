import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildZip } from '../zip-writer.js'

// App manifest schema v1.29, the newest generally available version on
// https://learn.microsoft.com/en-us/microsoft-365/extensibility/schema/ (checked 2026-10-27;
// 1.30 is listed there as upcoming, not GA).
const MANIFEST_VERSION = '1.29'
const SCHEMA_URL = `https://developer.microsoft.com/json-schemas/teams/v${MANIFEST_VERSION}/MicrosoftTeams.schema.json`

const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/teams')

// Spec §6.2 commands, typed in the chat.
const COMMANDS = [
  { title: 'help', description: 'What I can do' },
  { title: 'my work', description: 'Open your My Work inbox' },
  { title: 'mute 1h', description: 'Pause Teams notifications for an hour' },
  { title: 'unmute', description: 'Turn Teams notifications back on' },
  { title: 'settings', description: 'Choose which notifications reach Teams' },
  { title: 'link', description: 'Check your Teams connection' },
  { title: 'unlink', description: 'Disconnect Teams from Nivaro' }
]

export interface TeamsPackageInput {
  appId: string
  name: string
  shortDescription: string
  fullDescription: string
  /** Host of the public URL, e.g. nivaro.example.com (no scheme). */
  publicHost: string
  /** Other hosts the app may open (the admin host when it differs). */
  extraDomains?: string[]
  /** https URL used for the developer website, privacy and terms links. */
  developerUrl: string
  version?: string
}

export function buildManifest(i: TeamsPackageInput): Record<string, unknown> {
  const domains = [...new Set([i.publicHost, ...(i.extraDomains ?? [])].filter(Boolean))]
  return {
    $schema: SCHEMA_URL,
    manifestVersion: MANIFEST_VERSION,
    version: i.version ?? '1.0.0',
    id: i.appId,
    developer: {
      name: i.name,
      websiteUrl: i.developerUrl,
      privacyUrl: i.developerUrl,
      termsOfUseUrl: i.developerUrl
    },
    name: { short: i.name.slice(0, 30), full: i.name.slice(0, 100) },
    description: { short: i.shortDescription.slice(0, 80), full: i.fullDescription.slice(0, 4000) },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#00CEFF',
    bots: [
      {
        botId: i.appId,
        scopes: ['personal', 'team'],
        // supportsChannelFeatures is deliberately NOT set: the channel audience check (a bot answers
        // in a channel only when everyone there may see the answer) relies on standard channels
        // only. Shared and private channels are refused by the audience gate.
        isNotificationOnly: false,
        supportsFiles: false,
        commandLists: [
          { scopes: ['personal'], commands: COMMANDS },
          { scopes: ['team'], commands: COMMANDS }
        ]
      }
    ],
    permissions: ['identity', 'messageTeamMembers'],
    validDomains: domains
    // webApplicationInfo is omitted: v1 does no single sign-on from inside Teams.
  }
}

export function buildTeamsPackage(i: TeamsPackageInput): Buffer {
  return buildZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(buildManifest(i), null, 2)) },
    { name: 'color.png', data: readFileSync(join(ICON_DIR, 'color.png')) },
    { name: 'outline.png', data: readFileSync(join(ICON_DIR, 'outline.png')) }
  ])
}
