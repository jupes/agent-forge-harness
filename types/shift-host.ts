/** A sampled observation, never execution or cleanup authority. Missing shares remain unknown. */
export interface ShiftHostSnapshot {
  asOf: string;
  cpu: number | null;
  memory: number | null;
  busy: boolean;
}
