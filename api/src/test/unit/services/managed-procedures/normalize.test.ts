import { describe, expect, it } from 'vitest'
import {
  normalizeProcBody,
  procBodyHash,
  stripAppManagedMarker
} from '../../../../services/managed-procedures/normalize.js'

describe('normalizeProcBody', () => {
  it('matches deploy-procedures norm: marker, header verb, whitespace, case', () => {
    expect(
      normalizeProcBody('-- @app-managed: body owned by x\nCREATE PROCEDURE Foo AS\n  SELECT 1')
    ).toBe(normalizeProcBody('create or alter procedure foo as select 1'))
  })

  it('keeps a leading ordinary comment (it is part of the body)', () => {
    expect(normalizeProcBody('-- index needed\nCREATE PROC a AS SELECT 1')).toContain(
      '-- index needed'
    )
  })

  it('folds every header spelling to "create proc"', () => {
    const want = 'create proc a as select 1'
    for (const s of [
      'CREATE PROC a AS SELECT 1',
      'CREATE PROCEDURE a AS SELECT 1',
      'CREATE OR ALTER PROC a AS SELECT 1',
      'Create  Or\n Alter\tProcedure a AS SELECT 1'
    ]) {
      expect(normalizeProcBody(s)).toBe(want)
    }
  })

  it('a body change still changes the normal form', () => {
    expect(normalizeProcBody('CREATE PROC a AS SELECT 1')).not.toBe(
      normalizeProcBody('CREATE PROC a AS SELECT 2')
    )
  })
})

describe('procBodyHash', () => {
  it('procBodyHash is 64 hex and stable across CREATE vs CREATE OR ALTER', () => {
    expect(procBodyHash('CREATE PROC a AS SELECT 1')).toMatch(/^[0-9a-f]{64}$/)
    expect(procBodyHash('CREATE PROC a AS SELECT 1')).toBe(
      procBodyHash('create or alter procedure a as select 1')
    )
  })

  it('ignores the @app-managed marker line', () => {
    expect(procBodyHash('-- @app-managed: import x\nCREATE PROC a AS SELECT 1')).toBe(
      procBodyHash('CREATE PROC a AS SELECT 1')
    )
  })
})

describe('stripAppManagedMarker', () => {
  it('drops only a leading marker line', () => {
    expect(stripAppManagedMarker('-- @app-managed: owned\nCREATE PROC a AS SELECT 1')).toBe(
      'CREATE PROC a AS SELECT 1'
    )
    expect(stripAppManagedMarker('-- other\nCREATE PROC a AS SELECT 1')).toBe(
      '-- other\nCREATE PROC a AS SELECT 1'
    )
    expect(stripAppManagedMarker('CREATE PROC a AS\n-- @app-managed\nSELECT 1')).toBe(
      'CREATE PROC a AS\n-- @app-managed\nSELECT 1'
    )
  })
})
