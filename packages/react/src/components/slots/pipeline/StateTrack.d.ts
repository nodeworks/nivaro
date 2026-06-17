import { type PHistory } from './HistoryTimeline';
export type PState = {
    id: string;
    key: string;
    label: string;
    color: string | null;
    is_initial?: boolean;
    is_terminal?: boolean;
    sort?: number;
    stage_visibility?: 'always' | 'hide_unless_active' | 'hide';
};
export type PTransition = {
    id: string;
    label: string;
    color: string | null;
    to_state: string;
    from_state: string | null;
    group_label: string | null;
};
export declare function StateTrack({ states, allTransitions, availableTransitions, currentStateId, history }: {
    states: PState[];
    allTransitions: PTransition[];
    availableTransitions: PTransition[];
    currentStateId: string | null;
    history: PHistory[];
}): import("react").JSX.Element | null;
//# sourceMappingURL=StateTrack.d.ts.map