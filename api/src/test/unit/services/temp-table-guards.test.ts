import { describe, expect, it } from 'vitest'
import { tempTableGuards } from '../../../services/custom-query-dependents.js'

describe('tempTableGuards (#780)', () => {
  it('a wrapper that drops #b before building it is guarded', () => {
    const sql = `IF OBJECT_ID('tempdb..#b') IS NOT NULL DROP TABLE #b;
      CREATE TABLE #b (id INT, amount DECIMAL(18,2));
      INSERT INTO #b EXEC categories_breakdown_by_region @Projects = :projects;
      SELECT * FROM #b`
    expect(tempTableGuards(sql)).toEqual([{ table: '#b', guarded: true }])
  })
  it('a wrapper that builds #b with no drop first is flagged; a drop AFTER the build does not count', () => {
    const sql = `CREATE TABLE #b (id INT);
      INSERT INTO #b EXEC p;
      SELECT * FROM #b;
      DROP TABLE #b`
    expect(tempTableGuards(sql)).toEqual([{ table: '#b', guarded: false }])
  })
  it('SELECT … INTO #x counts as a build and DROP TABLE IF EXISTS as a guard; comments are ignored', () => {
    const sql = `-- IF OBJECT_ID('tempdb..#x') IS NOT NULL DROP TABLE #x
      DROP TABLE IF EXISTS #x;
      SELECT id INTO #x FROM projects;
      SELECT * INTO #y FROM #x`
    expect(tempTableGuards(sql)).toEqual([
      { table: '#x', guarded: true },
      { table: '#y', guarded: false }
    ])
  })
  it('a wrapper with no temp tables reports nothing', () => {
    expect(tempTableGuards('SELECT 1')).toEqual([])
  })
})
