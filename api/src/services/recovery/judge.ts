/**
 * The RPO / RTO panel's judgement (#2802) — pure: what is known about backups, the restore drill
 * and chaos recovery → one row per question, green / amber / red with the reason in words.
 *
 *   db_backup       newest database backup (full, differential or log) vs the RPO
 *   uploads_backup  newest uploads backup (monitoring-store metric) vs the RPO
 *   restore_drill   did the newest drill restore the backup, and how long ago
 *   restore_time    the newest passed drill's measured restore time vs the RTO
 *   chaos_recovery  chaos drills' time to recover (90 days) vs the RTO
 */

export type RecoveryTone = 'ok' | 'warn' | 'bad' | 'off'

export interface RecoveryRow {
  key: 'db_backup' | 'uploads_backup' | 'restore_drill' | 'restore_time' | 'chaos_recovery'
  label: string
  tone: RecoveryTone
  /** Short headline value ("3 h ago", "14 min"). */
  value: string
  /** The judgement in words. */
  reason: string
  /** The target it was judged against, in words. */
  target: string | null
}

export interface DrillDigest {
  verdict: 'passed' | 'failed' | 'blocked' | 'skipped' | 'ready'
  reason: string
  finished_at: string | null
  restore_ms: number | null
  backup_age_s: number | null
}

export interface JudgeInput {
  now: number
  rpo_minutes: number
  rto_minutes: number
  db: {
    newest: {
      full: { finish_utc: string; device: string } | null
      diff: { finish_utc: string; device: string } | null
      log: { finish_utc: string; device: string } | null
    } | null
    error: string | null
  }
  uploads: { age_s: number | null; part: string | null; error: string | null }
  drill: {
    enabled: boolean
    last: DrillDigest | null
    last_passed: DrillDigest | null
    running_since: string | null
  }
  chaos: {
    runs: number
    ttr_median_s: number | null
    ttr_p90_s: number | null
    ttd_median_s: number | null
    not_recovered: number
    window_days: number
  } | null
  chaos_error: string | null
}

export function fmtSpan(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`
  return `${Math.round(seconds / 86_400)} d`
}

const fmtMinutes = (m: number) => fmtSpan(m * 60)

/** Within the target → ok; up to 1.5× → warn (a late nightly); beyond → bad. */
function ageTone(ageS: number, targetMin: number): RecoveryTone {
  if (ageS <= targetMin * 60) return 'ok'
  if (ageS <= targetMin * 90) return 'warn'
  return 'bad'
}

const ageAgainst = (ageS: number, targetMin: number, what: string): string => {
  const tone = ageTone(ageS, targetMin)
  return tone === 'ok'
    ? `${what} ${fmtSpan(ageS)} ago, inside the ${fmtMinutes(targetMin)} RPO.`
    : `${what} ${fmtSpan(ageS)} ago, past the ${fmtMinutes(targetMin)} RPO: a disaster now would lose more than the target allows.`
}

function dbRow(i: JudgeInput): RecoveryRow {
  const target = `RPO ${fmtMinutes(i.rpo_minutes)}`
  const base = { key: 'db_backup' as const, label: 'Database backup', target }
  if (i.db.error)
    return {
      ...base,
      tone: 'warn',
      value: 'Unknown',
      reason: `Can't read the backup history in msdb: ${i.db.error}`
    }
  const n = i.db.newest
  const all = [
    n?.full && { kind: 'full', ...n.full },
    n?.diff && { kind: 'differential', ...n.diff },
    n?.log && { kind: 'log', ...n.log }
  ].filter((x): x is { kind: string; finish_utc: string; device: string } => !!x)
  if (!all.length)
    return {
      ...base,
      tone: 'bad',
      value: 'None',
      reason: 'msdb records no backup of this database on this server.'
    }
  const newest = all.reduce((a, b) => (a.finish_utc >= b.finish_utc ? a : b))
  const age = Math.max(0, (i.now - Date.parse(newest.finish_utc)) / 1000)
  const tone = ageTone(age, i.rpo_minutes)
  const fullAge = n?.full ? Math.max(0, (i.now - Date.parse(n.full.finish_utc)) / 1000) : null
  const fullNote =
    newest.kind !== 'full'
      ? fullAge == null
        ? ' No full backup is recorded, so nothing can be restored from it.'
        : ` Newest full ${fmtSpan(fullAge)} ago.`
      : ''
  return {
    ...base,
    tone: newest.kind !== 'full' && fullAge == null ? 'bad' : tone,
    value: `${fmtSpan(age)} ago`,
    reason: `${ageAgainst(age, i.rpo_minutes, `Newest ${newest.kind} backup, to a ${newest.device},`)}${fullNote}`
  }
}

function uploadsRow(i: JudgeInput): RecoveryRow {
  const target = `RPO ${fmtMinutes(i.rpo_minutes)}`
  const base = { key: 'uploads_backup' as const, label: 'Uploads backup', target }
  if (i.uploads.age_s == null)
    return {
      ...base,
      tone: 'warn',
      value: 'Not reported',
      reason: i.uploads.error
        ? `Can't tell: ${i.uploads.error}.`
        : 'No uploads backup reports to the monitoring store. Have the uploads backup push efp_backup_last_success_timestamp_seconds{part="uploads"} when it succeeds.'
    }
  return {
    ...base,
    tone: ageTone(i.uploads.age_s, i.rpo_minutes),
    value: `${fmtSpan(i.uploads.age_s)} ago`,
    reason: ageAgainst(
      i.uploads.age_s,
      i.rpo_minutes,
      `Uploads backup (${i.uploads.part ?? 'uploads'})`
    )
  }
}

function drillRow(i: JudgeInput): RecoveryRow {
  const base = { key: 'restore_drill' as const, label: 'Restore drill', target: 'Nightly' }
  const off = i.drill.enabled
    ? ''
    : ' The drill is off here (RESTORE_DRILL=on or the setting turns it on).'
  if (i.drill.running_since && !i.drill.last)
    return { ...base, tone: 'off', value: 'Running', reason: 'The first restore drill is running.' }
  const last = i.drill.last
  if (!last)
    return {
      ...base,
      tone: 'bad',
      value: 'Never',
      reason: `No restore drill has run. A backup that has never been restored is not a backup.${off}`
    }
  const ago = last.finished_at ? Math.max(0, (i.now - Date.parse(last.finished_at)) / 1000) : null
  const when = ago == null ? '' : ` ${fmtSpan(ago)} ago`
  if (last.verdict === 'failed')
    return {
      ...base,
      tone: 'bad',
      value: 'Failed',
      reason: `The newest drill${when} failed: ${last.reason}`
    }
  if (last.verdict === 'blocked')
    return {
      ...base,
      tone: 'warn',
      value: 'Could not run',
      reason: `The newest drill${when} could not restore: ${last.reason}`
    }
  // passed
  const tone: RecoveryTone =
    ago == null ? 'warn' : ago <= 2 * 86_400 ? 'ok' : ago <= 8 * 86_400 ? 'warn' : 'bad'
  return {
    ...base,
    tone,
    value: 'Passed',
    reason:
      tone === 'ok'
        ? `The newest drill${when} restored the backup and the restored copy checked out.`
        : `The newest drill passed, but${when}: the backups since are unproven.${off}`
  }
}

function timeRow(i: JudgeInput): RecoveryRow {
  const target = `RTO ${fmtMinutes(i.rto_minutes)}`
  const base = { key: 'restore_time' as const, label: 'Measured restore time', target }
  const p = i.drill.last_passed
  if (p?.restore_ms == null)
    return {
      ...base,
      tone: 'warn',
      value: 'Not measured',
      reason: 'No passed restore drill has measured how long restoring the database takes.'
    }
  const s = p.restore_ms / 1000
  const rto = i.rto_minutes * 60
  const tone: RecoveryTone = s <= rto * 0.75 ? 'ok' : s <= rto ? 'warn' : 'bad'
  const ageNote =
    p.backup_age_s != null
      ? ` The backup it restored was ${fmtSpan(p.backup_age_s)} old at the time.`
      : ''
  return {
    ...base,
    tone,
    value: fmtSpan(s),
    reason:
      tone === 'ok'
        ? `Restoring the database took ${fmtSpan(s)}, well inside the ${fmtMinutes(i.rto_minutes)} RTO (which also covers noticing, deciding and reconnecting).${ageNote}`
        : tone === 'warn'
          ? `Restoring the database took ${fmtSpan(s)}: inside the ${fmtMinutes(i.rto_minutes)} RTO, but it leaves little room for noticing, deciding and reconnecting.${ageNote}`
          : `Restoring the database took ${fmtSpan(s)}, longer than the ${fmtMinutes(i.rto_minutes)} RTO on its own.${ageNote}`
  }
}

function chaosRow(i: JudgeInput): RecoveryRow {
  const target = `RTO ${fmtMinutes(i.rto_minutes)}`
  const base = { key: 'chaos_recovery' as const, label: 'Chaos drill recovery', target }
  if (i.chaos_error)
    return {
      ...base,
      tone: 'off',
      value: '—',
      reason: `Chaos history unavailable: ${i.chaos_error}`
    }
  const c = i.chaos
  if (!c?.runs || c.ttr_p90_s == null)
    return {
      ...base,
      tone: 'off',
      value: 'No drills',
      reason: `No chaos drill measured a recovery in the last ${c?.window_days ?? 90} days.`
    }
  const detect = c.ttd_median_s == null ? '' : `, median time to detect ${fmtSpan(c.ttd_median_s)}`
  const facts = `p90 time to recover ${fmtSpan(c.ttr_p90_s)} (median ${fmtSpan(c.ttr_median_s ?? c.ttr_p90_s)}${detect}) over ${c.runs} drill${c.runs === 1 ? '' : 's'} in ${c.window_days} days`
  if (c.ttr_p90_s > i.rto_minutes * 60)
    return { ...base, tone: 'bad', value: fmtSpan(c.ttr_p90_s), reason: `${facts}: past the RTO.` }
  if (c.not_recovered > 0)
    return {
      ...base,
      tone: 'warn',
      value: fmtSpan(c.ttr_p90_s),
      reason: `${facts}; ${c.not_recovered} drill${c.not_recovered === 1 ? '' : 's'} did not recover on ${c.not_recovered === 1 ? 'its' : 'their'} own.`
    }
  return { ...base, tone: 'ok', value: fmtSpan(c.ttr_p90_s), reason: `${facts}.` }
}

export function judgeRecovery(i: JudgeInput): { rows: RecoveryRow[]; tone: RecoveryTone } {
  const rows = [dbRow(i), uploadsRow(i), drillRow(i), timeRow(i), chaosRow(i)]
  const rank: Record<RecoveryTone, number> = { off: 0, ok: 1, warn: 2, bad: 3 }
  const worst = rows.reduce<RecoveryTone>((a, r) => (rank[r.tone] > rank[a] ? r.tone : a), 'off')
  return { rows, tone: worst === 'off' ? 'ok' : worst }
}
