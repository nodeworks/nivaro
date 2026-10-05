#!/usr/bin/env node
/**
 * nivaro-mcp — serve a Nivaro instance to an MCP client over stdio.
 *
 *   nivaro-mcp [--url <api origin>] [--token <nvk_… key>]
 *
 * The URL and token also come from NIVARO_URL / NIVARO_TOKEN. The server
 * refuses to start without a token; the token is masked in every log line and
 * request bodies are never logged. stdout is the MCP channel — only stderr
 * carries diagnostics.
 *
 * Exit codes: 0 clean shutdown · 1 usage.
 */
import { serveStdio } from './index.js'
import { maskToken } from './result.js'

const argv = process.argv.slice(2)

function flag(name: string, short?: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || (short && a === `-${short}`))
  if (i === -1) return undefined
  return argv[i + 1]
}

function usage(code: number): never {
  process.stderr.write(
    [
      'Usage: nivaro-mcp [--url <api origin>] [--token <api key>]',
      '',
      '  --url    API origin, e.g. https://cms.example.com (or NIVARO_URL)',
      '  --token  An nvk_ API key or static token (or NIVARO_TOKEN)',
      '',
      'Speaks the Model Context Protocol over stdio. Add it to Claude Code with',
      '  claude mcp add nivaro -e NIVARO_URL=https://cms.example.com -e NIVARO_TOKEN=nvk_… -- npx -y @nivaro/mcp',
      ''
    ].join('\n')
  )
  process.exit(code)
}

if (argv.includes('--help') || argv.includes('-h')) usage(0)

const url = (flag('url', 'u') ?? process.env.NIVARO_URL ?? '').replace(/\/+$/, '')
const token = flag('token', 't') ?? process.env.NIVARO_TOKEN ?? ''

if (!url) {
  process.stderr.write('nivaro-mcp: missing --url (or NIVARO_URL)\n\n')
  usage(1)
}
if (!token) {
  process.stderr.write('nivaro-mcp: missing --token (or NIVARO_TOKEN) — refusing to start\n\n')
  usage(1)
}

try {
  await serveStdio({ url, token })
  process.stderr.write(`nivaro-mcp: serving ${url} as ${maskToken(token)}\n`)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`nivaro-mcp: ${message.replaceAll(token, maskToken(token))}\n`)
  process.exit(1)
}
