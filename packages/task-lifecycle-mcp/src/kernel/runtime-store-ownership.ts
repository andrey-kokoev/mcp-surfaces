type StoreSlot<T> = {
  generation: number;
  store: T;
};

type RequestLease<T> = {
  requestId: string;
  slot: StoreSlot<T>;
  released: boolean;
};

export type StoreLease<T> = {
  readonly store: T;
  release: () => void;
};

type ReplacementOptions<T> = {
  open: () => Promise<T> | T;
  requestId?: string;
};

/**
 * Serializes store replacement with request ownership. A request keeps the
 * exact handle it acquired until it completes. Replacement waits for old
 * leases, stages the candidate before publication, and restores the caller's
 * lease when staging or close fails.
 */
export class RuntimeStoreOwnership<T> {
  private current: StoreSlot<T> | null = null;
  private generation = 0;
  private leaseSequence = 0;
  private readonly leases = new Map<string, RequestLease<T>>();
  private readonly drainWaiters: Array<{ resolve: () => void; slot: StoreSlot<T> }> = [];
  private replacementTail: Promise<void> = Promise.resolve();
  private replacementCount = 0;

  public constructor(private readonly close: (store: T) => void) {}

  public get activeRequestCount(): number {
    return this.leases.size;
  }

  public get isTransitioning(): boolean {
    return this.replacementCount > 0;
  }

  public get currentGeneration(): number | null {
    return this.current?.generation ?? null;
  }

  public currentStore(): T | null {
    return this.current?.store ?? null;
  }

  public initialize(store: T): void {
    if (this.current) throw new Error('task_lifecycle_store_already_initialized');
    if (this.isTransitioning) throw new Error('task_lifecycle_store_transition_in_progress');
    this.current = { generation: ++this.generation, store };
  }

  public acquire(requestId?: string): StoreLease<T> {
    if (this.isTransitioning) throw new Error('task_lifecycle_store_transition_in_progress');
    const normalizedRequestId = requestId?.trim() || `anonymous-${++this.leaseSequence}`;
    const slot = this.current;
    if (!slot) throw new Error('task_lifecycle_store_unconfigured');
    const leaseId = `${normalizedRequestId}:${++this.leaseSequence}`;
    const lease: RequestLease<T> = { requestId: normalizedRequestId, slot, released: false };
    this.leases.set(leaseId, lease);
    return {
      get store() {
        return lease.slot.store;
      },
      release: () => {
        if (lease.released) return;
        lease.released = true;
        this.releaseLease(leaseId);
      },
    };
  }

  public async replace(options: ReplacementOptions<T>): Promise<T> {
    const requestId = options.requestId?.trim() || undefined;
    const transferredLeases = requestId ? this.detachRequestLeases(requestId) : [];

    this.replacementCount += 1;
    const operation = this.replacementTail.then(
      () => this.performReplacement(options, transferredLeases),
      () => this.performReplacement(options, transferredLeases),
    );
    this.replacementTail = operation.then(() => undefined, () => undefined);
    try {
      return await operation;
    } finally {
      this.replacementCount -= 1;
    }
  }

  public replaceSync(nextStore: T): void {
    if (this.activeRequestCount > 0) throw new Error('task_lifecycle_store_reconfigure_active_requests');
    if (this.isTransitioning) throw new Error('task_lifecycle_store_transition_in_progress');
    const old = this.current;
    if (old) {
      try {
        this.close(old.store);
      } catch (error) {
        try {
          this.close(nextStore);
        } catch {
          // Preserve the original close failure and the old published store.
        }
        throw error;
      }
    }
    this.current = { generation: ++this.generation, store: nextStore };
  }

  public closeCurrent(): void {
    if (this.activeRequestCount > 0) throw new Error('task_lifecycle_store_shutdown_active_requests');
    if (this.isTransitioning) throw new Error('task_lifecycle_store_transition_in_progress');
    const current = this.current;
    if (!current) return;
    this.close(current.store);
    this.current = null;
  }

  private async performReplacement(options: ReplacementOptions<T>, transferredLeases: Array<[string, RequestLease<T>]>): Promise<T> {
    const old = this.current;
    if (old) await this.waitForNoLeases(old);

    let next: T;
    try {
      next = await options.open();
    } catch (error) {
      this.restoreLeases(transferredLeases, this.current ?? old);
      throw error;
    }

    if (old) {
      try {
        this.close(old.store);
      } catch (error) {
        try {
          this.close(next);
        } catch {
          // Preserve the original close failure; the candidate is no longer published.
        }
        this.restoreLeases(transferredLeases, old);
        throw error;
      }
    }

    this.current = { generation: ++this.generation, store: next };
    this.restoreLeases(transferredLeases, this.current);
    return next;
  }

  private detachRequestLeases(requestId: string): Array<[string, RequestLease<T>]> {
    const detached: Array<[string, RequestLease<T>]> = [];
    for (const [leaseId, lease] of this.leases) {
      if (lease.requestId !== requestId) continue;
      this.leases.delete(leaseId);
      detached.push([leaseId, lease]);
    }
    return detached;
  }

  private restoreLeases(transferredLeases: Array<[string, RequestLease<T>]>, slot: StoreSlot<T> | null): void {
    if (!slot) return;
    for (const [leaseId, lease] of transferredLeases) {
      if (lease.released) continue;
      lease.slot = slot;
      this.leases.set(leaseId, lease);
    }
  }

  private releaseLease(leaseId: string): void {
    if (!this.leases.delete(leaseId)) return;
    for (let index = this.drainWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.drainWaiters[index];
      if (!this.hasLeaseForSlot(waiter.slot)) {
        this.drainWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  private hasLeaseForSlot(slot: StoreSlot<T>): boolean {
    for (const lease of this.leases.values()) {
      if (lease.slot === slot) return true;
    }
    return false;
  }

  private async waitForNoLeases(slot: StoreSlot<T>): Promise<void> {
    if (!this.hasLeaseForSlot(slot)) return;
    await new Promise<void>((resolve) => {
      this.drainWaiters.push({ resolve, slot });
    });
  }
}
