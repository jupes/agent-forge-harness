export interface ShiftDefault<T> {
  value: T;
  source: string;
}

/** A protected projection of defaults and choices, never execution authority. */
export interface ProjectShiftOptions {
  projectId: string;
  workspace: string;
  catalogRevision: number;
  asOf: string;
  defaults: {
    for: ShiftDefault<string>;
    concurrency: ShiftDefault<number>;
    maxBeads: ShiftDefault<number>;
    maxUsd: ShiftDefault<number>;
    repairs: ShiftDefault<number>;
    base: ShiftDefault<string>;
    runTimeout: ShiftDefault<null>;
  };
  limits: {
    durationMs: [number, number];
    concurrency: [number, number];
    maxBeads: [number, number];
    maxUsd: number;
    repairs: [number, number];
  };
  epics: { id: string; title: string }[];
  smiths: { names: string[]; defaultSmith: string | null };
  availability: { start: boolean; reason: string | null };
}
