/**
 * Process-wide HL REST weight budget (token bucket).
 *
 * HL docs: 1200 weight / minute / IP across info + exchange. Weights vary
 * (clearinghouse/allMids = 2, most other info = 20, unbatched exchange = 1).
 *
 * This is useful on shared AND dedicated egress — it stops *our* worker from
 * stampeding itself when AGENT_CONCURRENCY rises or exit retries fire.
 *
 * Set HL_WEIGHT_PER_MINUTE via env (prod dedicated egress ~1100; leave the
 * code default lower for local/shared). Multi-replica shards should each take
 * a slice of the IP budget, not the full 1200.
 */

export class HlWeightBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    /** Sustained refill rate (weight units per minute). */
    private readonly perMinute: number,
    /** Max burst (defaults to ~5s of refill, capped). */
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillMs;
    if (elapsed <= 0) return;
    const add = (this.perMinute * elapsed) / 60_000;
    this.tokens = Math.min(this.capacity, this.tokens + add);
    this.lastRefillMs = now;
  }

  /** Block until `weight` tokens are available, then consume them. */
  async acquire(weight: number): Promise<void> {
    const w = Math.max(1, Math.ceil(weight));
    for (;;) {
      this.refill();
      if (this.tokens >= w) {
        this.tokens -= w;
        return;
      }
      const need = w - this.tokens;
      // ms until `need` tokens refill at perMinute rate
      const waitMs = Math.max(50, Math.ceil((need / this.perMinute) * 60_000));
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 5_000)));
    }
  }
}

/** Info endpoint weights (HL docs). Default 20 for undocumented / other. */
export const HL_WEIGHT = {
  clearinghouseState: 2,
  spotClearinghouseState: 2,
  allMids: 2,
  /** L2 snapshot and single-order status are in the cheap (weight 2) class. */
  l2Book: 2,
  orderStatus: 2,
  meta: 20,
  /** Same weight class as meta (universe + per-asset ctx including funding). */
  metaAndAssetCtxs: 20,
  frontendOpenOrders: 20,
  userAbstraction: 20,
  userFills: 20,
  /** Unbatched exchange action. */
  exchange: 1,
} as const;
