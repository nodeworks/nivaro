import type {
  FieldCatalog,
  OwnerSheetContext,
  SheetGroup
} from '../../services/owner-matrix-sheet.js'

// A small owner matrix for the spreadsheet tests (not a test file itself).

export const S1 = 'AAAAAAAA-0000-4000-8000-000000000001'
export const S2 = 'AAAAAAAA-0000-4000-8000-000000000002'
export const S3 = 'AAAAAAAA-0000-4000-8000-000000000003'
export const G1 = 'BBBBBBBB-0000-4000-8000-000000000001'
export const G2 = 'BBBBBBBB-0000-4000-8000-000000000002'
export const G3 = 'BBBBBBBB-0000-4000-8000-000000000003'
export const G4 = 'BBBBBBBB-0000-4000-8000-000000000004'
export const ANN = 'CCCCCCCC-0000-4000-8000-000000000001'
export const BOB = 'CCCCCCCC-0000-4000-8000-000000000002'
export const PAT1 = 'CCCCCCCC-0000-4000-8000-000000000003'
export const PAT2 = 'CCCCCCCC-0000-4000-8000-000000000004'
export const SAM = 'CCCCCCCC-0000-4000-8000-000000000005'
export const NOMAIL = 'CCCCCCCC-0000-4000-8000-000000000006'

function catalog(values: Array<[string, number]>): FieldCatalog {
  return {
    checkable: true,
    complete: true,
    self: false,
    values: new Map(values.map(([v, id]) => [v.toLowerCase(), { value: v, ids: [id] }]))
  }
}

export function fixtureContext(overrides: Partial<OwnerSheetContext> = {}): OwnerSheetContext {
  const groups: SheetGroup[] = [
    {
      id: G1,
      state: S1,
      name: null,
      filters: [
        { field: 'regions.short_name', op: 'eq', value: 'East', id_value: 1 },
        { field: 'project.project_type.name', op: 'eq', value: 'New Build', id_value: 27 }
      ],
      is_default: false,
      priority: 0,
      members: [ANN, BOB, NOMAIL],
      teams: [1]
    },
    {
      id: G2,
      state: S1,
      name: 'legacy:owners:12',
      filters: [{ field: 'regions.short_name', op: 'eq', value: 'West', id_value: 2 }],
      is_default: false,
      priority: 0,
      members: [PAT1],
      teams: []
    },
    {
      id: G3,
      state: S2,
      name: null,
      filters: [],
      is_default: true,
      priority: 0,
      members: [ANN],
      teams: []
    },
    {
      id: G4,
      state: S3,
      name: 'Escalations',
      filters: [
        { field: 'regions.short_name', op: 'eq', value: 'East', id_value: 1 },
        { field: 'project.project_id', op: 'neq', value: '1234', id_value: null }
      ],
      is_default: false,
      priority: 5,
      members: [BOB],
      teams: []
    }
  ]
  return {
    template: { id: 'TPL', name: 'Purchase approval' },
    states: [
      { id: S1, key: 'submitted', label: 'Submitted', sort: 1 },
      { id: S2, key: 'review', label: 'Review', sort: 2 },
      { id: S3, key: 'approve', label: 'Approve', sort: 3 }
    ],
    fields: [
      {
        field: 'regions.short_name',
        header: 'Region',
        collection: 'orders',
        required: true,
        is_dimension: true
      },
      {
        field: 'project.project_type.name',
        header: 'Project Type',
        collection: 'orders',
        required: false,
        is_dimension: true
      }
    ],
    groups,
    people: [
      { id: ANN, email: 'ann@example.com', first_name: 'Ann', last_name: 'Lee', inactive: false },
      { id: BOB, email: 'bob@example.com', first_name: 'Bob', last_name: 'Ray', inactive: false },
      { id: PAT1, email: 'pat1@example.com', first_name: 'Pat', last_name: 'Kim', inactive: false },
      { id: PAT2, email: 'pat2@example.com', first_name: 'Pat', last_name: 'Kim', inactive: false },
      { id: SAM, email: 'sam@example.com', first_name: 'Sam', last_name: 'Ode', inactive: true },
      { id: NOMAIL, email: null, first_name: 'No', last_name: 'Mail', inactive: false }
    ],
    teams: [
      { id: 1, name: 'Field Ops', slug: 'field-ops' },
      { id: 2, name: 'Buyers', slug: 'buyers' }
    ],
    catalogs: new Map([
      [
        'regions.short_name',
        catalog([
          ['East', 1],
          ['West', 2],
          ['North', 3]
        ])
      ],
      [
        'project.project_type.name',
        catalog([
          ['New Build', 27],
          ['CRAN', 12]
        ])
      ]
    ]),
    matrixHash: 'a'.repeat(64),
    ...overrides
  }
}
