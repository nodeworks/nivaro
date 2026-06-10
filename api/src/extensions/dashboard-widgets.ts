export interface DashboardWidgetDef {
  type: string
  label: string
  icon?: string
  /** JSON schema for the widget's configuration options. Displayed in the widget picker. */
  configSchema?: Record<string, unknown>
  /** Description shown in the widget picker. */
  description?: string
}

class DashboardWidgetRegistry {
  private widgets = new Map<string, DashboardWidgetDef>()

  register(def: DashboardWidgetDef): void {
    if (this.widgets.has(def.type)) {
      throw new Error(`Dashboard widget type "${def.type}" already registered`)
    }
    this.widgets.set(def.type, def)
  }

  unregister(type: string): void {
    this.widgets.delete(type)
  }

  list(): DashboardWidgetDef[] {
    return [...this.widgets.values()]
  }

  get(type: string): DashboardWidgetDef | undefined {
    return this.widgets.get(type)
  }
}

export const dashboardWidgetRegistry = new DashboardWidgetRegistry()
