import { z } from "zod";
import { NotSent, type OperatorPost } from "../../../docs/js/operator";
import {
  canonicalKnowledgeRefresh,
  type KnowledgeReceipt,
  type KnowledgeStatus,
  knowledgeReceiptSchema,
  knowledgeStatusSchema,
} from "../../../scripts/projects/knowledge-protocol";

const pendingSchema = z
  .record(
    z.string().regex(/^project-[a-f0-9-]{36}$/),
    z
      .object({
        requestId: z.uuid(),
        requestHash: z.string().regex(/^[a-f0-9]{64}$/),
        revision: z.number().int().nonnegative(),
        repositoryKey: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  )
  .refine((value) => Object.keys(value).length <= 100);
type Pending = z.infer<typeof pendingSchema>;
const envelope = z
  .object({
    ok: z.literal(true),
    data: knowledgeReceiptSchema,
    error: z.null(),
  })
  .strict();
const base = (id: string) =>
  `/projects/${encodeURIComponent(id)}/settings/knowledge`;
export interface ProjectKnowledgeView {
  pending: Pending;
  statuses: Record<string, KnowledgeStatus>;
  receipts: Record<string, KnowledgeReceipt>;
  messages: Record<string, string>;
  loading: Record<string, boolean>;
  busy: string | null;
  storageError: boolean;
}
export class ProjectKnowledgeOwner {
  private value: ProjectKnowledgeView = {
    pending: {},
    statuses: {},
    receipts: {},
    messages: {},
    loading: {},
    busy: null,
    storageError: false,
  };
  private listeners = new Set<(value: ProjectKnowledgeView) => void>();
  private reads = new Map<string, number>();
  constructor(
    private deps: {
      read(url: string): Promise<unknown>;
      post: OperatorPost;
      readPending(): unknown;
      writePending(value: Pending): void;
      withLock<T>(work: () => Promise<T>): Promise<T>;
      uuid(): string;
      hash(text: string): Promise<string>;
    },
  ) {
    try {
      this.value.pending = pendingSchema.parse(deps.readPending());
    } catch {
      this.value.storageError = true;
    }
  }
  snapshot = () => this.value;
  subscribe = (listener: (value: ProjectKnowledgeView) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    this.value = { ...this.value };
    for (const listener of this.listeners) listener(this.value);
  }
  private message(id: string, text: string) {
    this.value.messages = { ...this.value.messages, [id]: text };
  }
  async inspect(id: string): Promise<KnowledgeStatus | null> {
    const turn = (this.reads.get(id) ?? 0) + 1;
    this.reads.set(id, turn);
    this.value.loading = { ...this.value.loading, [id]: true };
    this.emit();
    try {
      const status = knowledgeStatusSchema.parse(
        await this.deps.read(base(id)),
      );
      if (status.projectId !== id)
        throw Error("Knowledge source changed project");
      if (this.reads.get(id) !== turn) return null;
      this.value.statuses = { ...this.value.statuses, [id]: status };
      return status;
    } catch {
      if (this.reads.get(id) === turn)
        this.message(
          id,
          "Knowledge freshness could not be checked. Retained values are from the last verified read.",
        );
      return null;
    } finally {
      if (this.reads.get(id) === turn) {
        this.value.loading = { ...this.value.loading, [id]: false };
        this.emit();
      }
    }
  }
  private async adopt() {
    try {
      await this.deps.withLock(async () => {
        this.value.pending = {
          ...pendingSchema.parse(this.deps.readPending()),
          ...this.value.pending,
        };
      });
    } catch (error) {
      this.value.storageError = true;
      throw error;
    }
  }
  private async claim(id: string, original: Pending[string]): Promise<boolean> {
    try {
      return await this.deps.withLock(async () => {
        const fresh = pendingSchema.parse(this.deps.readPending());
        if (fresh[id]) {
          this.value.pending = {
            ...fresh,
            ...this.value.pending,
            [id]: fresh[id],
          };
          return false;
        }
        const next = pendingSchema.parse({ ...fresh, [id]: original });
        this.deps.writePending(next);
        this.value.pending = { ...next, ...this.value.pending, [id]: original };
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
        current.revision === original.revision &&
        current.repositoryKey === original.repositoryKey
      ) {
        delete fresh[id];
        this.deps.writePending(fresh);
      }
      const retained = { ...this.value.pending },
        local = retained[id];
      if (
        local?.requestId === original.requestId &&
        local.requestHash === original.requestHash &&
        local.revision === original.revision &&
        local.repositoryKey === original.repositoryKey
      )
        delete retained[id];
      this.value.pending = { ...fresh, ...retained };
    });
  }
  private async accept(id: string, raw: unknown) {
    const receipt = knowledgeReceiptSchema.parse(raw),
      original = this.value.pending[id];
    if (
      !original ||
      receipt.projectId !== id ||
      receipt.requestId !== original.requestId ||
      receipt.requestHash !== original.requestHash ||
      receipt.repositoryKey !== original.repositoryKey
    )
      throw Error("Knowledge receipt does not match the saved original");
    this.value.receipts = { ...this.value.receipts, [id]: receipt };
    this.message(id, receipt.message);
    if (["confirmed", "failed", "refused"].includes(receipt.state)) {
      try {
        await this.clear(id, original);
      } catch {
        this.value.storageError = true;
        this.message(
          id,
          receipt.message +
            " Recovery metadata cleanup failed; the confirmed receipt is retained.",
        );
      }
      if (receipt.state === "confirmed") await this.inspect(id);
    }
  }
  async checkOriginal(id: string) {
    if (this.value.busy || this.value.storageError) return;
    this.value.busy = id;
    this.emit();
    try {
      await this.adopt();
      const original = this.value.pending[id];
      if (!original) {
        this.message(
          id,
          "No retained knowledge original is recorded in this browser.",
        );
        return;
      }
      await this.accept(
        id,
        await this.deps.read(
          base(id) + "/" + encodeURIComponent(original.requestId),
        ),
      );
    } catch {
      if (!this.value.receipts[id] || this.value.pending[id])
        this.message(
          id,
          "The original refresh remains unconfirmed. Check its exact receipt again; no generation or publication was repeated.",
        );
    } finally {
      this.value.busy = null;
      this.emit();
    }
  }
  async refresh(id: string) {
    if (this.value.busy || this.value.storageError || this.value.pending[id])
      return;
    const reviewed = this.value.statuses[id];
    if (!reviewed || reviewed.archived) return;
    this.value.busy = id;
    this.emit();
    let claimed: Pending[string] | null = null,
      sent = false,
      refusal = "";
    try {
      const current = await this.inspect(id);
      if (
        !current ||
        current.archived ||
        current.catalogRevision !== reviewed.catalogRevision ||
        current.repositoryKey !== reviewed.repositoryKey
      )
        throw Error("Knowledge scope changed before admission");
      const request = {
        requestId: this.deps.uuid(),
        expectedRevision: current.catalogRevision,
        repositoryKey: current.repositoryKey,
      };
      const original = {
        requestId: request.requestId,
        requestHash: await this.deps.hash(
          canonicalKnowledgeRefresh(id, request),
        ),
        revision: request.expectedRevision,
        repositoryKey: request.repositoryKey,
      };
      if (!(await this.claim(id, original))) {
        this.message(
          id,
          "Another tab retained a knowledge original. Check that receipt; no new refresh was sent.",
        );
        return;
      }
      claimed = original;
      let response: Response;
      try {
        sent = true;
        response = await this.deps.post("/__agent-forge" + base(id), request);
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
        try {
          const body = z
            .object({
              ok: z.literal(false),
              data: z.null(),
              error: z.string().min(1).max(1000),
            })
            .strict()
            .safeParse(await response.json());
          if (body.success) refusal = body.data.error;
        } catch {
          /* A known refusal does not require an error body to prove nondelivery. */
        }
        throw Error("Knowledge refresh was refused before admission");
      }
      if (!response.ok) throw Error("Knowledge refresh outcome is unknown");
      await this.accept(id, envelope.parse(await response.json()).data);
    } catch {
      if (claimed && !sent) {
        try {
          await this.clear(id, claimed);
        } catch {
          this.value.storageError = true;
        }
      }
      this.message(
        id,
        sent
          ? "The refresh outcome is unconfirmed. Check the saved original; generation will not be repeated automatically."
          : refusal ||
              "No new refresh was admitted. Check current knowledge and project settings before reviewing another request.",
      );
    } finally {
      this.value.busy = null;
      this.emit();
    }
  }
  async recover(id: string, operation: "publish" | "retire") {
    if (this.value.busy || this.value.storageError) return;
    const original = this.value.pending[id],
      receipt = this.value.receipts[id];
    if (
      !original ||
      !receipt ||
      receipt.requestId !== original.requestId ||
      receipt.requestHash !== original.requestHash ||
      (operation === "retire"
        ? !["candidate-saved", "generation-completed"].includes(receipt.state)
        : receipt.candidateHash === null ||
          !["candidate-saved", "unknown", "publishing"].includes(receipt.state))
    )
      return;
    this.value.busy = id;
    this.emit();
    try {
      const response = await this.deps.post(
        "/__agent-forge" +
          base(id) +
          "/" +
          encodeURIComponent(original.requestId) +
          "/" +
          operation,
        { requestHash: original.requestHash },
      );
      if (!response.ok) throw Error("Knowledge recovery refused");
      await this.accept(id, envelope.parse(await response.json()).data);
    } catch {
      this.message(
        id,
        "Recovery was not confirmed. The exact original remains held; check its receipt before another explicit action.",
      );
    } finally {
      this.value.busy = null;
      this.emit();
    }
  }
}
