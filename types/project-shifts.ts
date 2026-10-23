export interface ShiftDefault<T> {
  value: T;
  source: string;
}

/** Full reviewed bounds; absence of runTimeout retains the shift's remaining-time limit. */
export interface ProjectShiftStartOptions {
  for: string;
  concurrency: number;
  maxBeads: number;
  maxUsd: number;
  repairs: number;
  base: string;
  epic?: string | undefined;
  smith?: string | undefined;
  runTimeout?: string | undefined;
}
export interface ProjectShiftStartRequest {
  requestId: string;
  expectedCatalogRevision: number;
  options: ProjectShiftStartOptions;
}
export interface ProjectShiftIntent {
  projectId: string;
  workspace: string;
  shiftId: string;
  request: ProjectShiftStartRequest;
  requestHash: string;
  createdAt: string;
  attemptedAt: string | null;
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
