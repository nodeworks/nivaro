import type { Transformer } from './index.js'
import {
  insertBefore,
  isOp,
  kw,
  lineOf,
  readsStatus,
  STMT,
  scan,
  splice,
  statementEnd,
  statementStartOk
} from './scan.js'

/**
 * Every `#t` a body BUILDS (SELECT … INTO #t / CREATE TABLE #t) must be dropped first — a failed
 * earlier batch leaves it on the pooled connection and the next run dies "there is already an
 * object named #t". The guard goes right before the FIRST build. Declines per table:
 * - when `#t` appears before its first build at all (a guard of any spelling, or a table the
 *   caller owns) — so `INSERT INTO #t EXEC` alone is never a build: that table is the caller's;
 * - when the build is the lone body of an IF / ELSE / WHILE, or a CTE / INSERT owns it — a new
 *   statement there would change the control flow;
 * - when the build reads @@ROWCOUNT / ROWCOUNT_BIG() / @@ERROR — the guard would reset them;
 * - for `##global` tables, which other sessions may be using.
 */
const guard = (name: string): string =>
  `IF OBJECT_ID('tempdb..${name}') IS NOT NULL DROP TABLE ${name};`

const isLocalTemp = (text: string | undefined): boolean => !!text && /^#[^#]/.test(text)

export const tempTableGuard: Transformer = {
  id: 'temp-table-guard',
  apply(body) {
    const s = scan(body)
    if (!s.balanced) return null
    const { toks } = s
    const builds = new Map<string, { name: string; at: number }>()
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].depth !== 0) continue
      const w = kw(s, k)
      let name: string | undefined
      if (w === 'CREATE' && kw(s, k + 1) === 'TABLE' && isLocalTemp(toks[k + 2]?.text))
        name = toks[k + 2].text
      else if (w === 'SELECT') {
        // SELECT … INTO #t: INTO at depth 0 before the FROM / the statement's end
        for (let j = k + 1; j < toks.length; j++) {
          if (toks[j].depth !== 0) continue
          if (isOp(s, j, ';')) break
          const wj = kw(s, j)
          if (wj === 'CASE') j = s.caseEnd.get(j) ?? j
          else if (wj === 'INTO') {
            if (isLocalTemp(toks[j + 1]?.text)) name = toks[j + 1].text
            break
          } else if (wj === 'FROM' || wj === 'UNION' || (STMT.has(wj) && wj !== 'WITH')) break
        }
      }
      if (name && !builds.has(name.toLowerCase())) builds.set(name.toLowerCase(), { name, at: k })
    }

    const edits: Array<[number, number, string]> = []
    const notes: string[] = []
    for (const [key, b] of builds) {
      if (toks.slice(0, b.at).some((t) => t.kind === 'word' && t.text.toLowerCase() === key))
        continue
      if (!statementStartOk(s, b.at)) continue
      if (readsStatus(s, b.at, statementEnd(s, b.at))) continue
      const [at, text] = insertBefore(body, toks[b.at].start, [guard(b.name)])
      edits.push([at, at, text])
      notes.push(
        `line ${lineOf(body, toks[b.at].start)}: ${b.name} is built without a drop guard — added one`
      )
    }
    return notes.length ? { body: splice(body, edits), notes } : null
  }
}
