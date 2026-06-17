export interface M2MStagingCtx {
    getStagedLinks: (key: string) => unknown[];
    getStagedUnlinks: (key: string) => Set<unknown>;
    stageLink: (key: string, relatedId: unknown) => void;
    stageUnlink: (key: string, junctionId: unknown) => void;
    unstageLink: (key: string, relatedId: unknown) => void;
    unstageUnlink: (key: string, junctionId: unknown) => void;
}
export declare const M2MStagingContext: import("react").Context<M2MStagingCtx | null>;
export declare function useM2MStaging(): M2MStagingCtx | null;
//# sourceMappingURL=M2MStagingContext.d.ts.map