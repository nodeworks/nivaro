export type PHistory = {
    id: string;
    from_state: string | null;
    to_state: string;
    from_state_label?: string;
    to_state_label: string;
    from_state_color?: string | null;
    to_state_color?: string | null;
    comment?: string | null;
    timestamp: string;
    first_name?: string | null;
    last_name?: string | null;
    user_email?: string | null;
};
export declare function relFmt(iso: string): string;
export declare function initials(first: string | null | undefined, last: string | null | undefined, email: string | null | undefined): string;
export declare function HistoryTimeline({ history }: {
    history: PHistory[];
}): import("react").JSX.Element;
//# sourceMappingURL=HistoryTimeline.d.ts.map