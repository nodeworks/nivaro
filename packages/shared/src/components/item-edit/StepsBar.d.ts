import type { StepDef } from './types';
export declare function StepsBar({ steps, active, completed, onStepClick }: {
    steps: StepDef[];
    active: string;
    completed: Set<string>;
    onStepClick: (k: string) => void;
}): import("react").JSX.Element;
//# sourceMappingURL=StepsBar.d.ts.map