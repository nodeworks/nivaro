import type { DashboardWidgetDef } from '@nivaro/extension-kit'

export type { DashboardWidgetDef } from '@nivaro/extension-kit'

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
