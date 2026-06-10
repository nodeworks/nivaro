export interface ValidatorDef {
  /** Operator name used in validation_rules JSON, e.g. 'phone', 'iban', 'luhn'. */
  operator: string
  label: string
  /** Returns null on pass, or an error message string on fail. */
  validate(value: unknown, options?: unknown): string | null
}

class ValidatorRegistry {
  private validators = new Map<string, ValidatorDef>()

  register(def: ValidatorDef): void {
    if (this.validators.has(def.operator))
      throw new Error(`Validator operator "${def.operator}" already registered`)
    this.validators.set(def.operator, def)
  }

  unregister(operator: string): void {
    this.validators.delete(operator)
  }

  /** Run a registered validator. Returns error string or null. */
  run(operator: string, value: unknown, options?: unknown): string | null {
    return this.validators.get(operator)?.validate(value, options) ?? null
  }

  list(): Omit<ValidatorDef, 'validate'>[] {
    return [...this.validators.values()].map(({ validate: _v, ...rest }) => rest)
  }

  has(operator: string): boolean {
    return this.validators.has(operator)
  }
}

export const validatorRegistry = new ValidatorRegistry()
