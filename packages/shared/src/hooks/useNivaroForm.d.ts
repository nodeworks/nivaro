import type { NivaroClient } from '@nivaro/sdk';
import type { FormLockCondition, FormVisibilityRule, UseNivaroFormOptions, UseNivaroFormReturn } from '../types';
export declare function isFieldVisible(rules: FormVisibilityRule[] | null, values: Record<string, unknown>): boolean;
export declare function isFieldLocked(condition: FormLockCondition | null, values: Record<string, unknown>): boolean;
export declare function useNivaroForm(collection: string, options: UseNivaroFormOptions, client?: NivaroClient): UseNivaroFormReturn;
//# sourceMappingURL=useNivaroForm.d.ts.map