export type FieldType = { value: string; label: string; group: string }

export const FIELD_TYPES: FieldType[] = [
  { value: 'string', label: 'String', group: 'Text' },
  { value: 'text', label: 'Text (long)', group: 'Text' },
  { value: 'csv', label: 'CSV', group: 'Text' },
  { value: 'hash', label: 'Hash / Password', group: 'Text' },
  { value: 'integer', label: 'Integer', group: 'Number' },
  { value: 'bigInteger', label: 'Big Integer', group: 'Number' },
  { value: 'float', label: 'Float', group: 'Number' },
  { value: 'decimal', label: 'Decimal', group: 'Number' },
  { value: 'boolean', label: 'Boolean', group: 'Boolean' },
  { value: 'date', label: 'Date', group: 'Date & Time' },
  { value: 'datetime', label: 'Date & Time', group: 'Date & Time' },
  { value: 'time', label: 'Time', group: 'Date & Time' },
  { value: 'timestamp', label: 'Timestamp', group: 'Date & Time' },
  { value: 'uuid', label: 'UUID', group: 'Other' },
  { value: 'json', label: 'JSON', group: 'Other' },
  { value: 'alias', label: 'Alias (virtual)', group: 'Other' }
]

export type InterfaceOption = { value: string; label: string }

export const INTERFACES_BY_TYPE: Record<string, InterfaceOption[]> = {
  string: [
    { value: 'input', label: 'Text Input' },
    { value: 'input-multiline', label: 'Textarea' },
    { value: 'input-rich-text-md', label: 'Markdown' },
    { value: 'select-dropdown', label: 'Dropdown' },
    { value: 'select-radio', label: 'Radio Buttons' },
    { value: 'select-multiple-checkbox', label: 'Checkboxes (multi-select)' },
    { value: 'tags', label: 'Tags' },
    { value: 'color', label: 'Color Picker' },
    { value: 'slug', label: 'Slug' },
    { value: 'input-hash', label: 'Password / Hash' }
  ],
  text: [
    { value: 'input', label: 'Text Input' },
    { value: 'input-multiline', label: 'Textarea' },
    { value: 'input-rich-text-md', label: 'Markdown' },
    { value: 'input-rich-text-html', label: 'WYSIWYG' },
    { value: 'input-code', label: 'Code Editor' }
  ],
  integer: [
    { value: 'input', label: 'Number Input' },
    { value: 'slider', label: 'Slider' },
    { value: 'select-dropdown', label: 'Dropdown' },
    { value: 'select-radio', label: 'Radio Buttons' }
  ],
  bigInteger: [{ value: 'input', label: 'Number Input' }],
  float: [
    { value: 'input', label: 'Number Input' },
    { value: 'slider', label: 'Slider' }
  ],
  decimal: [{ value: 'input', label: 'Number Input' }],
  boolean: [
    { value: 'toggle', label: 'Toggle' },
    { value: 'checkbox', label: 'Checkbox' },
    { value: 'boolean', label: 'Boolean Select' }
  ],
  date: [{ value: 'datetime', label: 'Date Picker' }],
  datetime: [{ value: 'datetime', label: 'Date & Time Picker' }],
  time: [{ value: 'datetime', label: 'Time Picker' }],
  timestamp: [{ value: 'datetime', label: 'Date & Time Picker' }],
  uuid: [{ value: 'input', label: 'Text Input (readonly)' }],
  json: [
    { value: 'input-code', label: 'Code Editor' },
    { value: 'list', label: 'Repeater List' }
  ],
  csv: [{ value: 'tags', label: 'Tags' }],
  hash: [{ value: 'input-hash', label: 'Password / Hash' }],
  alias: [
    { value: 'group-detail', label: 'Group (accordion)' },
    { value: 'group-raw', label: 'Group (always open)' },
    { value: 'presentation-divider', label: 'Divider' },
    { value: 'presentation-notice', label: 'Notice / Banner' }
  ],
  m2o: [
    { value: 'relation-picker', label: 'Relation Picker (default)' },
    { value: 'input', label: 'Plain Text (FK value)' }
  ],
  m2m: [
    { value: 'relation-m2m', label: 'Tags Picker (default)' },
    { value: 'select-multiple-m2m', label: 'Multiselect Combobox' }
  ],
  o2m: [
    { value: 'relation-list', label: 'Related Items List (default)' },
    { value: 'inline-grid', label: 'Inline Grid' }
  ]
}

export type DisplayOption = { value: string; label: string }

export const DISPLAYS_BY_TYPE: Record<string, DisplayOption[]> = {
  string: [
    { value: 'raw', label: 'Raw value' },
    { value: 'formatted-value', label: 'Formatted (prefix / suffix)' },
    { value: 'label', label: 'Label / Badge' }
  ],
  text: [
    { value: 'raw', label: 'Raw value' },
    { value: 'formatted-value', label: 'Formatted' }
  ],
  integer: [
    { value: 'raw', label: 'Raw value' },
    { value: 'formatted-value', label: 'Formatted (prefix / suffix)' }
  ],
  bigInteger: [
    { value: 'raw', label: 'Raw value' },
    { value: 'formatted-value', label: 'Formatted' }
  ],
  float: [
    { value: 'raw', label: 'Raw value' },
    { value: 'formatted-value', label: 'Formatted' }
  ],
  decimal: [
    { value: 'raw', label: 'Raw value' },
    { value: 'formatted-value', label: 'Formatted' }
  ],
  boolean: [
    { value: 'boolean', label: 'Boolean labels' },
    { value: 'icon', label: 'Icon (check / cross)' }
  ],
  date: [
    { value: 'datetime', label: 'Date' },
    { value: 'relative', label: 'Relative (e.g. "3 days ago")' }
  ],
  datetime: [
    { value: 'datetime', label: 'Date & Time' },
    { value: 'relative', label: 'Relative' }
  ],
  time: [{ value: 'datetime', label: 'Time' }],
  timestamp: [
    { value: 'datetime', label: 'Date & Time' },
    { value: 'relative', label: 'Relative' }
  ],
  uuid: [{ value: 'raw', label: 'Raw value' }],
  json: [{ value: 'raw', label: 'Raw JSON' }],
  csv: [
    { value: 'labels', label: 'Labels / Badges' },
    { value: 'raw', label: 'Raw value' }
  ],
  hash: [{ value: 'raw', label: 'Raw value' }],
  alias: []
}

export function getInterfaces(type: string): InterfaceOption[] {
  return INTERFACES_BY_TYPE[type] ?? [{ value: 'input', label: 'Text Input' }]
}

export function getDisplays(type: string): DisplayOption[] {
  return DISPLAYS_BY_TYPE[type] ?? [{ value: 'raw', label: 'Raw value' }]
}

export function getDefaultInterface(type: string): string {
  return getInterfaces(type)[0]?.value ?? 'input'
}

export function getDefaultDisplay(type: string): string {
  return getDisplays(type)[0]?.value ?? 'raw'
}

// Interfaces that require a choices list
export const CHOICE_INTERFACES = new Set([
  'select-dropdown',
  'select-radio',
  'select-multiple-checkbox'
])

export const SLIDER_INTERFACES = new Set(['slider'])
export const DATETIME_INTERFACES = new Set(['datetime'])
export const COLOR_INTERFACES = new Set(['color'])

export type Choice = { value: string; text: string }
export type LabelChoice = { value: string; text: string; background: string; foreground: string }

export function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}
