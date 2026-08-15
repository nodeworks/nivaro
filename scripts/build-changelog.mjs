#!/usr/bin/env node
/**
 * Turn the git history into changelog.json, which ships inside the image.
 *
 *   node scripts/build-changelog.mjs        # regenerate
 *
 * Read from TAGS at build time rather than at runtime, because the running
 * container has no git repository — and stored as data rather than prose so the
 * page can mark which release is currently running.
 *
 * Deliberately deterministic: no model, no API key, nothing that can fail or
 * drift at release time. It reports what was committed, grouped by the
 * conventional-commit prefix people already write.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const OUT = 'changelog.json'

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

/** Release tags, newest first. `v*` is the app; the package tags are separate. */
const tags = git(['tag', '--list', 'v*', '--sort=-creatordate'])
  .split('\n')
  .map((t) => t.trim())
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))

if (tags.length === 0) {
  writeFileSync(OUT, JSON.stringify({ releases: [] }, null, 2))
  console.log('No version tags found — wrote an empty changelog.')
  process.exit(0)
}

/** What kind of change a conventional-commit subject describes. */
const SECTIONS = [
  { key: 'feat', label: 'Added' },
  { key: 'fix', label: 'Fixed' },
  { key: 'perf', label: 'Performance' },
  { key: 'refactor', label: 'Changed' },
  { key: 'docs', label: 'Documentation' }
]

/** Release-plumbing commits describe the release, not what changed in it. */
const NOISE = /^chore(\(.+\))?: release |^chore(\(.+\))?: redeploy /i

function entriesFor(fromTag, toTag) {
  const range = fromTag ? `${fromTag}..${toTag}` : toTag
  const raw = spawnSync(
    'git',
    ['log', range, '--no-merges', '--pretty=format:%s%h'],
    { encoding: 'utf8' }
  )
  if (raw.status !== 0) return []

  const out = []
  for (const line of (raw.stdout ?? '').split('\n')) {
    const [subject, hash] = line.split('')
    if (!subject || NOISE.test(subject)) continue
    const m = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject)
    const type = m?.[1]?.toLowerCase() ?? 'other'
    const section = SECTIONS.find((s) => s.key === type)?.label ?? 'Other'
    out.push({
      section,
      scope: m?.[2] ?? null,
      text: (m?.[3] ?? subject).trim(),
      hash: hash ?? null
    })
  }
  return out
}

const releases = tags.map((tag, i) => {
  // Tags are newest-first, so the previous release is the NEXT element.
  const previous = tags[i + 1] ?? null
  const date = git(['log', '-1', '--format=%cI', tag])
  const entries = entriesFor(previous, tag)
  const grouped = {}
  for (const e of entries) {
    grouped[e.section] ??= []
    grouped[e.section].push(e)
  }
  return {
    version: tag.replace(/^v/, ''),
    tag,
    date,
    // Section order is meaningful — what was added, then what was fixed.
    sections: [...SECTIONS.map((s) => s.label), 'Other']
      .filter((label, idx, arr) => arr.indexOf(label) === idx)
      .map((label) => ({ label, entries: grouped[label] ?? [] }))
      .filter((s) => s.entries.length > 0),
    count: entries.length
  }
})

writeFileSync(OUT, `${JSON.stringify({ generated_at: new Date().toISOString(), releases }, null, 2)}\n`)
console.log(`✓ ${OUT} — ${releases.length} releases, newest ${releases[0]?.version}`)
