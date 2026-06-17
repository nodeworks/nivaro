export interface LockHolder {
    locked_by: string;
    locked_by_name: string | null;
}
export declare function useItemLock(collection: string | undefined, item: string | undefined, enabled: boolean): {
    lockHolder: LockHolder | null;
    acquired: boolean;
    isReadOnly: boolean;
    takeOver: () => Promise<void>;
    takingOver: boolean;
    isAdmin: boolean;
};
export declare function ItemLockBanner({ lockHolder, onTakeOver, takingOver, isAdmin }: {
    lockHolder: LockHolder | null;
    onTakeOver: () => void;
    takingOver: boolean;
    isAdmin?: boolean;
}): import("react").JSX.Element | null;
//# sourceMappingURL=ItemLockBanner.d.ts.map