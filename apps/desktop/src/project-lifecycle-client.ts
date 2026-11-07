import { z } from "zod";
import { NotSent, type OperatorPost } from "../../../docs/js/operator";
import {
  canonicalProjectDeletion,
  type ProjectDeletionReceipt,
  type ProjectDeletionStatus,
  projectDeletionReceiptSchema,
  projectDeletionStatusSchema,
} from "../../../scripts/projects/project-lifecycle-protocol";
import type { ProjectValueSpec } from "./project-value-settings-client";

export const projectArchiveSpec: ProjectValueSpec<boolean> = {
  key: "archived",
  label: "Archive preference",
  parse: (value) => z.boolean().parse(value),
};
const pendingSchema = z
  .record(
    z.string().regex(/^project-[a-f0-9-]{36}$/),
    z
      .object({
        requestId: z.uuid(),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/),
        revision: z.number().int().nonnegative(),
      })
      .strict(),
  )
  .refine((value) => Object.keys(value).length <= 100);
type Pending = z.infer<typeof pendingSchema>;
export interface ProjectLifecycleView {
  pending: Pending;
  receipts: Record<string, ProjectDeletionReceipt>;
  statuses: Record<string, ProjectDeletionStatus>;
  busy: string | null;
  message: string;
  messageProjectId: string | null;
  storageError: boolean;
}
export class ProjectLifecycleOwner {
  private value: ProjectLifecycleView = {
    pending: {},
    receipts: {},
    statuses: {},
    busy: null,
    message: "",
    messageProjectId: null,
    storageError: false,
  };
  private listeners = new Set<(value: ProjectLifecycleView) => void>();
  constructor(
    private deps: {
      read(url: string): Promise<unknown>;
      post: OperatorPost;
      readPending(): unknown;
      writePending(value: Pending): void;
      withLock<T>(work: () => Promise<T>): Promise<T>;
      uuid(): string;
      hash(text: string): Promise<string>;
      refresh?(): Promise<unknown>;
    },
  ) {
    try {
      this.value.pending = pendingSchema.parse(deps.readPending());
    } catch {
      this.value.storageError = true;
      this.value.message =
        "Deletion recovery metadata could not be restored. Restore browser storage before deleting a project.";
    }
  }
  snapshot = () => this.value;
  subscribe = (listener: (value: ProjectLifecycleView) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    this.value = { ...this.value };
    for (const listener of this.listeners) listener(this.value);
  }
  private async claim(id: string, original: Pending[string]) {
    try {
      return await this.deps.withLock(async () => {
        const fresh = pendingSchema.parse(this.deps.readPending());
        this.value.pending = fresh;
        if (fresh[id]) {
          this.value.message =
            "Another tab retained a deletion original. Check its exact receipt before doing anything else.";
          return false;
        }
        const next = pendingSchema.parse({ ...fresh, [id]: original });
        this.deps.writePending(next);
        this.value.pending = next;
        return true;
      });
    } catch (error) {
      this.value.storageError = true;
      throw error;
    }
  }
  private async clear(id: string, original: Pending[string]) {
    await this.deps.withLock(async () => {
      const fresh = pendingSchema.parse(this.deps.readPending()),
        current = fresh[id];
      if (
        current?.requestId === original.requestId &&
        current.requestHash === original.requestHash &&
        current.revision === original.revision
      ) {
        delete fresh[id];
        this.deps.writePending(fresh);
      }
      this.value.pending = fresh;
    });
  }
  private async confirm(id: string, raw: unknown) {
    const receipt = projectDeletionReceiptSchema.parse(raw),
      pending = this.value.pending[id];
    if (
      !pending ||
      receipt.projectId !== id ||
      receipt.requestId !== pending.requestId ||
      receipt.requestHash !== pending.requestHash ||
      receipt.deletedRevision !== pending.revision + 1
    )
      throw Error("Deletion receipt does not match its saved original");
    // A confirmed durable receipt stays true even if local metadata cleanup fails.
    this.value.receipts = { ...this.value.receipts, [id]: receipt };
    this.value.message =
      "Project record deleted. Repositories, beads, worktrees and provider histories were retained.";
    try {
      await this.clear(id, pending);
    } catch {
      this.value.storageError = true;
      this.value.message +=
        " Recovery metadata cleanup failed; keep this receipt and restore storage.";
    }
  }
  async check(id: string) {
    if (this.value.busy || this.value.storageError) return;
    this.value.busy = id;
    this.value.messageProjectId = id;
    this.emit();
    try {
      await this.deps.withLock(async () => {
        this.value.pending = {
          ...pendingSchema.parse(this.deps.readPending()),
          ...this.value.pending,
        };
      });
      const pending = this.value.pending[id];
      if (pending) {
        await this.confirm(
          id,
          await this.deps.read(
            `/projects/${encodeURIComponent(id)}/settings/deletion/${pending.requestId}`,
          ),
        );
        await this.deps.refresh?.();
      } else {
        const status = projectDeletionStatusSchema.parse(
          await this.deps.read(
            `/projects/${encodeURIComponent(id)}/settings/deletion`,
          ),
        );
        if (status.projectId !== id)
          throw Error("Deletion status scope changed");
        this.value.statuses = { ...this.value.statuses, [id]: status };
        this.value.message =
          status.state === "eligible"
            ? "Saved work is settled. Delete checks it again atomically before removing the project record."
            : status.reasons.join(" ");
      }
    } catch {
      this.value.message = this.value.receipts[id]
        ? "The saved deletion receipt is confirmed; the Projects refresh is unavailable."
        : this.value.pending[id]
          ? "The original deletion is still unconfirmed. Check its exact receipt again; no request was repeated."
          : "Deletion eligibility could not be verified. Refresh before deleting.";
      delete this.value.statuses[id];
    } finally {
      this.value.busy = null;
      this.emit();
    }
  }
  async remove(id: string, name: string) {
    const prior = this.value.statuses[id];
    if (
      this.value.busy ||
      this.value.storageError ||
      this.value.pending[id] ||
      this.value.receipts[id] ||
      prior?.state !== "eligible"
    )
      return;
    this.value.busy = id;
    this.value.messageProjectId = id;
    this.emit();
    let sent = false;
    let claimed: Pending[string] | null = null;
    try {
      const current = projectDeletionStatusSchema.parse(
        await this.deps.read(
          `/projects/${encodeURIComponent(id)}/settings/deletion`,
        ),
      );
      if (
        current.projectId !== id ||
        current.state !== "eligible" ||
        current.catalogRevision !== prior.catalogRevision
      )
        throw Error(
          "Project or owned work changed. Check and review deletion again.",
        );
      const request = {
        requestId: this.deps.uuid(),
        expectedRevision: prior.catalogRevision,
        confirmName: name,
      };
      const requestHash = await this.deps.hash(
        canonicalProjectDeletion(id, request),
      );
      const original = {
        requestId: request.requestId,
        requestHash,
        revision: request.expectedRevision,
      };
      if (!(await this.claim(id, original))) return;
      claimed = original;
      let response: Response;
      try {
        sent = true;
        response = await this.deps.post(
          `/__agent-forge/projects/${encodeURIComponent(id)}/settings/deletion`,
          request,
        );
      } catch (error) {
        if (error instanceof NotSent) sent = false;
        throw error;
      }
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
      ) {
        sent = false;
        throw Error(
          `Deletion was refused (HTTP ${response.status}). Check current work and review again.`,
        );
      }
      if (!response.ok) throw Error("Deletion outcome unknown");
      const raw: unknown = await response.json();
      if (
        !raw ||
        typeof raw !== "object" ||
        !("ok" in raw) ||
        raw.ok !== true ||
        !("error" in raw) ||
        raw.error !== null ||
        !("data" in raw)
      )
        throw Error("Invalid deletion envelope");
      await this.confirm(id, raw.data);
      await this.deps.refresh?.();
    } catch (error) {
      if (this.value.receipts[id])
        this.value.message =
          "The saved deletion receipt is confirmed; the Projects refresh is unavailable.";
      else if (sent)
        this.value.message =
          "Deletion outcome unknown. The original UUID is retained. Check its exact receipt; a new deletion will not be sent.";
      else {
        try {
          if (claimed) await this.clear(id, claimed);
        } catch {
          this.value.storageError = true;
        }
        this.value.message =
          error instanceof Error
            ? error.message
            : "Deletion was not sent. Check and review again.";
      }
    } finally {
      delete this.value.statuses[id];
      this.value.busy = null;
      this.emit();
    }
  }
}
