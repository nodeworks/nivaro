import type { NivaroClient } from '@nivaro/sdk';
import type { UseNivaroFormOptions, UseNivaroFormReturn } from '../types';
/**
 * Primary form hook for Nivaro CMS.
 *
 * IMPORTANT: Pass a stable `client` reference (defined outside the component
 * or wrapped in useMemo). A new object on every render triggers schema
 * re-fetches and item reloads on every render cycle.
 */
export declare function useNivaroForm(collection: string, options: UseNivaroFormOptions, client?: NivaroClient): UseNivaroFormReturn;
//# sourceMappingURL=useNivaroForm.d.ts.map