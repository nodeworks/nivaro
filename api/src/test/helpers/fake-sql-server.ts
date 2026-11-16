// biome-ignore-all lint/suspicious/noAssignInExpressions: regex dispatch reads best as if ((m = …))
/**
 * A tiny in-memory stand-in for the SQL the environment-refresh modules send (cross-database
 * `[DB].dbo.[table]` names, `?` bindings). It understands exactly the statement shapes those
 * modules build — anything else throws, so a new shape fails its test instead of passing silently.
 */
import type { SqlRunner } from '../../services/env-refresh/keep-set.js'

export interface FakeTable {
  cols: string[]
  rows: Array<Record<string, unknown>>
  identity?: string
  /** WHERE text → JS predicate (rows entries, safety filters). */
  where?: Record<string, (r: Record<string, unknown>) => boolean>
  /** Reject inserts whose row fails this (an FK stand-in). */
  reject?: (r: Record<string, unknown>) => boolean
}

export class FakeSqlServer implements SqlRunner {
  dbs = new Map<string, Map<string, FakeTable>>()
  log: string[] = []
  writes: string[] = []

  table(db: string, name: string, t: FakeTable): this {
    if (!this.dbs.has(db)) this.dbs.set(db, new Map())
    this.dbs.get(db)!.set(name, { ...t, rows: t.rows.map((r) => ({ ...r })) })
    return this
  }
  get(db: string, name: string): FakeTable | undefined {
    return this.dbs.get(db)?.get(name)
  }

  async raw(sql: string, b: unknown[] = []): Promise<Array<Record<string, unknown>>> {
    const q = sql.replace(/\s+/g, ' ').trim()
    this.log.push(q)
    let m: RegExpMatchArray | null
    if (
      (m = q.match(/FROM \[(\w+)\]\.sys\.(columns|identity_columns) c JOIN \[\w+\]\.sys\.tables t/))
    ) {
      const t = this.get(m[1], String(b[0]))
      if (!t) return []
      if (m[2] === 'columns') return t.cols.map((name) => ({ name }))
      return t.identity ? [{ name: t.identity }] : []
    }
    if (
      (m = q.match(
        /^SELECT (TOP \d+ )?(.+?) FROM \[(\w+)\]\.dbo\.\[(\w+)\](?: WHERE (.+?))?( ORDER BY .+)?$/
      ))
    ) {
      const t = this.get(m[3], m[4])
      if (!t) throw Object.assign(new Error(`Invalid object name '${m[4]}'`), { errors: [] })
      let rows = this.filter(t, m[5])
      if (m[1]) rows = rows.slice(0, Number(m[1].replace(/\D/g, '')))
      if (/^COUNT\(\*\) AS n$/.test(m[2])) return [{ n: rows.length }]
      if (m[2] === '*') return rows.map((r) => ({ ...r }))
      const cols = m[2].split(',').map((c) => c.trim())
      return rows.map((r) =>
        Object.fromEntries(
          cols.map((c) => {
            const nul = c.match(/^NULL AS (\w+)$/)
            if (nul) return [nul[1], null]
            const name = c.replace(/^\[|\]$/g, '')
            return [name, r[name]]
          })
        )
      )
    }
    if (
      (m = q.match(
        /^SELECT f\.\[id\], f\.\[name\] FROM \[(\w+)\]\.dbo\.\[nivaro_flows\] f WHERE f\.\[status\] = 'active' AND EXISTS .+ o\.\[type\] IN \((.+)\)\)$/
      ))
    ) {
      const flows = this.get(m[1], 'nivaro_flows')
      const ops = this.get(m[1], 'nivaro_flow_operations')
      const types = m[2].split(', ').map((v) => v.replace(/'/g, ''))
      return (flows?.rows ?? [])
        .filter((f) => f.status === 'active')
        .filter((f) =>
          (ops?.rows ?? []).some((o) => o.flow === f.id && types.includes(String(o.type)))
        )
        .map((f) => ({ id: f.id, name: f.name }))
    }
    if (
      (m = q.match(
        /^SELECT o\.\[id\] AS id, f\.\[name\] AS flow_name, .+ FROM \[(\w+)\]\.dbo\.\[nivaro_flow_operations\] o JOIN/
      ))
    ) {
      const flows = this.get(m[1], 'nivaro_flows')?.rows ?? []
      return (this.get(m[1], 'nivaro_flow_operations')?.rows ?? []).flatMap((o) => {
        const f = flows.find((x) => x.id === o.flow)
        return f
          ? [{ id: o.id, flow_name: f.name, op_key: o.key, op_name: o.name, options: o.options }]
          : []
      })
    }
    if ((m = q.match(/^DELETE FROM \[(\w+)\]\.dbo\.\[(\w+)\]( WHERE \[id\] IN \((.+)\))?$/))) {
      this.writes.push(q)
      const t = this.need(m[1], m[2])
      if (!m[3]) t.rows = []
      else {
        const ids = new Set(b.map((x) => String(x).toLowerCase()))
        t.rows = t.rows.filter((r) => !ids.has(String(r.id).toLowerCase()))
      }
      return []
    }
    if ((m = q.match(/INSERT INTO \[(\w+)\]\.dbo\.\[(\w+)\] \((.+?)\) VALUES (.+?);/))) {
      this.writes.push(q)
      const t = this.need(m[1], m[2])
      const cols = m[3].split(',').map((c) => c.trim().replace(/^\[|\]$/g, ''))
      const n = b.length / cols.length
      const add: Array<Record<string, unknown>> = []
      for (let i = 0; i < n; i++)
        add.push(Object.fromEntries(cols.map((c, j) => [c, b[i * cols.length + j]])))
      if (t.reject && add.some(t.reject))
        throw Object.assign(new Error('FK conflict'), {
          errors: [{ number: 547, message: 'FK conflict' }]
        })
      if (t.identity && cols.includes(t.identity) && !/IDENTITY_INSERT/.test(q))
        throw new Error('explicit identity without IDENTITY_INSERT')
      t.rows.push(...add)
      return []
    }
    if ((m = q.match(/^UPDATE \[(\w+)\]\.dbo\.\[(\w+)\] SET (.+?)(?: WHERE (.+))?$/))) {
      this.writes.push(q)
      const t = this.need(m[1], m[2])
      const sets = m[3].split(/, (?=\[)/).map((s) => s.match(/^\[(\w+)\] = (.+)$/)!)
      let bi = 0
      const vals = sets.map(
        ([, c, v]) =>
          [
            c,
            v === '?'
              ? b[bi++]
              : v === '1'
                ? 1
                : v === '0'
                  ? 0
                  : v === 'NULL'
                    ? null
                    : v.replace(/^'|'$/g, '')
          ] as const
      )
      const keyed = m[4]?.match(/^\[(\w+)\] = \?( AND \[(\w+)\] = \?)*$/)
      const keys = keyed ? [...m[4].matchAll(/\[(\w+)\] = \?/g)].map((x) => x[1]) : null
      const keyVals = keys ? b.slice(bi) : []
      const inList = m[4]?.match(/^\[(\w+)\] IN \(\?(, \?)*\)$/)
      const inVals = inList ? new Set(b.slice(bi).map((x) => String(x).toLowerCase())) : null
      for (const r of t.rows) {
        if (inList) {
          if (!inVals!.has(String(r[inList[1]]).toLowerCase())) continue
        } else if (keys) {
          const hit = keys.every(
            (k, i) => String(r[k]).toLowerCase() === String(keyVals[i]).toLowerCase()
          )
          if (!hit) continue
        } else if (m[4] && !this.filter(t, m[4]).includes(r)) continue
        for (const [c, v] of vals) r[c] = v
      }
      return []
    }
    throw new Error(`fake SQL server does not understand: ${q.slice(0, 160)}`)
  }

  private need(db: string, name: string): FakeTable {
    const t = this.get(db, name)
    if (!t) throw new Error(`no table ${db}.${name}`)
    return t
  }

  private filter(t: FakeTable, where?: string): Array<Record<string, unknown>> {
    if (!where) return t.rows
    const fn = t.where?.[where]
    if (fn) return t.rows.filter(fn)
    let m: RegExpMatchArray | null
    if ((m = where.match(/^\[(\w+)\] = 1$/)))
      return t.rows.filter((r) => r[m![1]] === 1 || r[m![1]] === true)
    if ((m = where.match(/^\[(\w+)\] IS NOT NULL$/))) return t.rows.filter((r) => r[m![1]] != null)
    if ((m = where.match(/^\[(\w+)\] = '(\w+)'$/))) return t.rows.filter((r) => r[m![1]] === m![2])
    if ((m = where.match(/^\[(\w+)\] IN \(('\w+'(?:, '\w+')*)\)$/))) {
      const vals = m[2].split(', ').map((v) => v.replace(/'/g, ''))
      return t.rows.filter((r) => vals.includes(String(r[m![1]])))
    }
    if (/ISNULL\(/.test(where)) {
      const cols = [...where.matchAll(/ISNULL\(\[(\w+)\], 0\) = 0/g)].map((x) => x[1])
      return t.rows.filter((r) => cols.some((c) => !r[c]))
    }
    throw new Error(`fake SQL server: no predicate for WHERE ${where}`)
  }
}
