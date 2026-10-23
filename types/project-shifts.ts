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
  /** Additive v1 field: absent on older originals; a marker never proves a provider turn. */
  executionStartedAt?: string | null | undefined;
}

export interface ProjectShiftReceipt {
  intent: ProjectShiftIntent;
  observation: ProjectShiftObservation;
}
export interface ProjectShiftsPage {
  projectId: string;
  asOf: string;
  items: ProjectShiftReceipt[];
}

export interface ProjectShiftObservation {
  shiftId: string;
  requestId: string;
  phase:
    | "reserved"
    | "unknown"
    | "starting"
    | "failed"
    | "running"
    | "throttled"
    | "stopping"
    | "stopped"
    | "needs-recovery";
  reason: string | null;
  actual: {
    startedAt: string;
    endedAt: string | null;
    deadline: string;
    concurrency: number;
    forMs: number;
    maxBeads: number;
    maxUsd: number;
    repairs: number;
    throttle: number | null;
    base: string;
    epic: string | null;
    smith: string | null;
    runTimeoutMs: number | null;
    spentUsd: number;
    unpriced: number;
    admitted: number | null;
    reviewed: number;
    running: number;
    halted: number;
    host?: ShiftHostSnapshot | null | undefined;
  } | null;
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

import type { ShiftHostSnapshot } from "./shift-host";
