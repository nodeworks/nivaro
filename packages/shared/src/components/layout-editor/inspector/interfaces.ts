// Interfaces a field may use on a form, by abstract type — the admin data
// model's lists (admin/src/lib/field-config.ts INTERFACES_BY_TYPE plus the
// Layouts tab's interface pack), which the shared FieldRenderer dispatches.

export type InterfaceOption = { value: string; label: string }

const BY_TYPE: Record<string, InterfaceOption[]> = {
  string: [
    { value: 'input', label: 'Text input' },
    { value: 'input-multiline', label: 'Textarea' },
    { value: 'input-rich-text-md', label: 'Markdown' },
    { value: 'select-dropdown', label: 'Dropdown' },
    { value: 'select-radio', label: 'Radio buttons' },
    { value: 'select-multiple-checkbox', label: 'Checkboxes (multi-select)' },
    { value: 'tags', label: 'Tags' },
    { value: 'color', label: 'Color picker' },
    { value: 'slug', label: 'Slug' },
    { value: 'fiscal_period', label: 'Fiscal period (FY/Q)' },
    { value: 'input-hash', label: 'Password / hash' },
    { value: 'checklist', label: 'Checklist (todo list)' },
    { value: 'phone', label: 'Phone number' },
    { value: 'email', label: 'Email address' },
    { value: 'address-autocomplete', label: 'Address (autocomplete)' }
  ],
  text: [
    { value: 'input', label: 'Text input' },
    { value: 'input-multiline', label: 'Textarea' },
    { value: 'input-rich-text-md', label: 'Markdown' },
    { value: 'input-rich-text-html', label: 'WYSIWYG' },
    { value: 'input-code', label: 'Code editor' },
    { value: 'checklist', label: 'Checklist (todo list)' },
    { value: 'address', label: 'Structured address' },
    { value: 'phone', label: 'Phone number' },
    { value: 'email', label: 'Email address' },
    { value: 'address-autocomplete', label: 'Address (autocomplete)' }
  ],
  integer: [
    { value: 'input', label: 'Number input' },
    { value: 'slider', label: 'Slider' },
    { value: 'rating', label: 'Rating (1-5 stars)' },
    { value: 'duration', label: 'Duration (h:mm → minutes)' },
    { value: 'range_slider', label: 'Range slider (paired)' },
    { value: 'select-dropdown', label: 'Dropdown' },
    { value: 'select-radio', label: 'Radio buttons' },
    { value: 'progress', label: 'Progress (0–100 %)' }
  ],
  bigInteger: [{ value: 'input', label: 'Number input' }],
  float: [
    { value: 'input', label: 'Number input' },
    { value: 'slider', label: 'Slider' }
  ],
  decimal: [{ value: 'input', label: 'Number input' }],
  boolean: [
    { value: 'toggle', label: 'Toggle' },
    { value: 'checkbox', label: 'Checkbox' },
    { value: 'boolean', label: 'Yes / no select' }
  ],
  date: [
    { value: 'datetime', label: 'Date picker' },
    { value: 'date_range', label: 'Date range (paired)' }
  ],
  datetime: [{ value: 'datetime', label: 'Date & time picker' }],
  time: [{ value: 'datetime', label: 'Time picker' }],
  timestamp: [{ value: 'datetime', label: 'Date & time picker' }],
  uuid: [{ value: 'input', label: 'Text input (read-only)' }],
  json: [
    { value: 'input-code', label: 'Code editor' },
    { value: 'list', label: 'Repeater list' },
    { value: 'repeater', label: 'Repeater (schema rows)' },
    { value: 'checklist', label: 'Checklist (todo list)' }
  ],
  csv: [{ value: 'tags', label: 'Tags' }],
  hash: [{ value: 'input-hash', label: 'Password / hash' }],
  alias: [
    { value: 'group-detail', label: 'Group (accordion)' },
    { value: 'group-raw', label: 'Group (always open)' },
    { value: 'presentation-divider', label: 'Divider' },
    { value: 'presentation-notice', label: 'Notice / banner' }
  ],
  m2o: [
    { value: 'relation-picker', label: 'Relation picker' },
    { value: 'relation-grouped', label: 'Grouped combobox' },
    { value: 'file-image', label: 'File picker' },
    { value: 'input', label: 'Plain text (stored id)' }
  ],
  m2m: [
    { value: 'relation-m2m', label: 'Tags picker' },
    { value: 'select-multiple-m2m', label: 'Multiselect combobox' },
    { value: 'files-m2m', label: 'File picker' }
  ],
  o2m: [
    { value: 'relation-list', label: 'Related items list' },
    { value: 'inline-grid', label: 'Inline grid' },
    { value: 'inline-table', label: 'Inline table' }
  ]
}

/**
 * Interface ids stored by older layouts (Directus-era names) and the input
 * each one is today. Shown by its current name instead of the raw id.
 */
const LEGACY: Record<string, string> = {
  'select-dropdown-m2o': 'relation-picker',
  'many-to-one': 'relation-picker',
  'list-m2m': 'relation-m2m',
  'many-to-many': 'relation-m2m',
  'list-o2m': 'relation-list',
  'one-to-many': 'relation-list',
  'list-o2m-tree-view': 'relation-list',
  files: 'files-m2m',
  file: 'file-image',
  'text-input': 'input',
  textarea: 'input-multiline',
  wysiwyg: 'input-rich-text-html',
  markdown: 'input-rich-text-md',
  dropdown: 'select-dropdown',
  'datetime-picker': 'datetime'
}

export function interfaceOptions(abstractType: string): InterfaceOption[] {
  return BY_TYPE[abstractType] ?? [{ value: 'input', label: 'Text input' }]
}

/** The option a stored id stands for today (itself, or its legacy successor); null = unknown. */
export function currentInterface(abstractType: string, value: string | null): string | null {
  if (!value) return null
  const opts = interfaceOptions(abstractType)
  if (opts.some((o) => o.value === value)) return value
  const next = LEGACY[value]
  return next && opts.some((o) => o.value === next) ? next : null
}

/** Plain name of an interface id; null when it is not one this type offers. */
export function interfaceLabel(abstractType: string, value: string | null): string | null {
  const v = currentInterface(abstractType, value)
  return v ? (interfaceOptions(abstractType).find((o) => o.value === v)?.label ?? null) : null
}
