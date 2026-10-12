#!/usr/bin/env tsx
/**
 * Builds api/src/services/docs-index.json — the in-app docs (the same
 * navSections the admin Docs page renders) flattened into plain text blocks,
 * so Ask AI's search_docs tool can search and quote them server-side (#1803).
 * The API never imports admin source; this file is the bridge.
 *
 * Run: pnpm docs:ai-index   (also runs from pnpm sync-docs)
 *
 * Audience: a section is 'all' when its nav group is reader-facing (overview,
 * user guide, collaboration) and 'admin' otherwise, unless the section sets
 * its own `audience`. Ask AI leaves 'admin' sections out for non-admins.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { navSections } from '../admin/src/docs/index.js'
import type { ContentNode, DocSection } from '../admin/src/docs/types.js'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = resolve(ROOT, 'api/src/services/docs-index.json')

/** Nav groups a non-admin reader may open. Everything else is admin material. */
const READER_GROUPS = new Set(['overview', 'user-guide', 'collaboration'])
/** Code samples are useful but long — keep the head of each. */
const MAX_CODE = 240

interface IndexBlock {
  /** The heading this passage sits under, if any. */
  h: string | null
  /** The passage: every block under that heading, joined. */
  t: string
}

interface IndexSection {
  id: string
  label: string
  group: string
  group_label: string
  audience: 'all' | 'admin'
  blocks: IndexBlock[]
}

const plain = (s: string): string =>
  s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()

function nodeText(node: ContentNode): string | null {
  switch (node.type) {
    case 'p':
    case 'note':
    case 'warn':
      return plain(node.text)
    case 'ul':
      return node.items.map((i) => `• ${plain(i)}`).join(' ')
    case 'pre':
      return node.code.length > MAX_CODE ? `${node.code.slice(0, MAX_CODE)}…` : node.code
    case 'table':
      return [node.head.join(' | '), ...node.rows.map((r) => r.map(plain).join(' | '))].join(' / ')
    default:
      return null
  }
}

function indexSection(
  section: DocSection & { audience?: 'all' | 'admin' },
  groupId: string,
  groupLabel: string
): IndexSection {
  const blocks: IndexBlock[] = []
  let heading: string | null = null
  for (const node of section.content) {
    if (node.type === 'h1' || node.type === 'h2' || node.type === 'h3') {
      heading = plain(node.text)
      continue
    }
    const t = nodeText(node)
    if (!t) continue
    const prev = blocks[blocks.length - 1]
    if (prev && prev.h === heading) prev.t = `${prev.t}\n${t}`
    else blocks.push({ h: heading, t })
  }
  return {
    id: section.id,
    label: section.label,
    group: groupId,
    group_label: groupLabel,
    audience: section.audience ?? (READER_GROUPS.has(groupId) ? 'all' : 'admin'),
    blocks
  }
}

const seen = new Set<string>()
const sections: IndexSection[] = []
for (const g of navSections) {
  for (const s of g.items) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    sections.push(indexSection(s, g.id, g.label))
  }
}

// One line, unformatted: a generated file (biome.json leaves it out).
writeFileSync(OUT, `${JSON.stringify({ version: 1, sections })}\n`)
// biome-ignore lint/suspicious/noConsole: a build script reports what it wrote
console.log(`  ✓ api/src/services/docs-index.json — ${sections.length} sections`)
