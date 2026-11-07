// Which page-builder widgets a viewer gets. A widget whose config says
// `admin_only: true` (e.g. the budget pages' setup editors: Manage Project
// Type Budget Targets, Manage Forecast, Manage Production & Forecast Numbers)
// is shown to administrators only. This keys on the person being an admin —
// never on `can()`: Workflow Creator / Approver hold `*` policies, so a
// permission check would show the editors to them anyway. The server's write
// guard refuses their writes either way; this only stops offering the button.
// The admin PageView applies the same rule inline (it renders from
// page.layout too).

export type AccessCheckedWidget = { config?: Record<string, unknown> | null }

export function isAdminOnlyWidget(w: AccessCheckedWidget): boolean {
  return (w.config as { admin_only?: unknown } | null | undefined)?.admin_only === true
}

export function visiblePageWidgets<W extends AccessCheckedWidget>(
  widgets: readonly W[],
  isAdmin: boolean
): W[] {
  return isAdmin ? [...widgets] : widgets.filter((w) => !isAdminOnlyWidget(w))
}
