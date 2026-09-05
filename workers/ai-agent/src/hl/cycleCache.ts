/**
 * Per-cycle HL info cache — shared across all agents in one worker cycle.
 *
 * Why (shared OR dedicated egress):
 *   Without this, one agent can call clearinghouseState / spot / abstraction /
 *   frontendOpenOrders / allMids many times per symbol. At N agents on the same
 *   master that becomes N× redundant IP weight. Caching is correct either way;
 *   shared egress just makes the pain show up sooner.
 *
 * Semantics:
 *   • Fresh map every cycle (caller constructs or calls clear()).
 *   • In-flight promises are cached so concurrent agents on the same wallet
 *     coalesce to one network round-trip.
 *   • After any exchange write that can change positions / orders / margin,
 *     the adapter MUST invalidate that wallet (and optionally mids).
 *
 * Keep this cache even with dedicated egress — it is the main lever for
 * "many agents / few HL reads". Pair with HL_WEIGHT_PER_MINUTE if raising
 * AGENT_CONCURRENCY. Optional later: shard workers by hash(master) % N.
 */

type Hex = `0x${string}`;

export type HlWalletBundle = {
  clearinghouse: any;
  spot: any | null;
  abstraction: unknown;
};

type CacheEntry<T> = { promise: Promise<T> };
/** Entry with an issue time so callers can demand a maximum age. */
type AgedEntry<T> = { promise: Promise<T>; at: number };

/** Main-dex meta + asset ctxs (funding, mark, OI, …) — one fetch per cycle. */
export type HlMetaAndAssetCtxs = [meta: { universe: { name: string }[] }, assetCtxs: any[]];

export class HlCycleCache {
  private wallets = new Map<string, CacheEntry<HlWalletBundle>>();
  private openOrders = new Map<string, CacheEntry<any[]>>();
  private userFills = new Map<string, CacheEntry<any[]>>();
  private mids: CacheEntry<Record<string, string>> | null = null;
  private metaAndAssetCtxs: CacheEntry<HlMetaAndAssetCtxs> | null = null;
  /** L2 book snapshots by HL coin name — books move, so entries carry an age. */
  private l2Books = new Map<string, AgedEntry<unknown>>();

  clear(): void {
    this.wallets.clear();
    this.openOrders.clear();
    this.userFills.clear();
    this.mids = null;
    this.metaAndAssetCtxs = null;
    this.l2Books.clear();
  }

  /**
   * L2 book for `coin`, reusing a cached snapshot no older than `maxAgeMs`.
   * Prompt context tolerates minutes; execution asks for ~seconds (or 0 to
   * force a fresh pull). In-flight promises coalesce like the other maps.
   */
  getL2Book<T>(coin: string, fetch: () => Promise<T>, maxAgeMs: number): Promise<T> {
    const key = coin;
    const hit = this.l2Books.get(key) as AgedEntry<T> | undefined;
    const now = Date.now();
    if (hit && now - hit.at <= maxAgeMs) return hit.promise;
    const promise = fetch().catch((err) => {
      if (this.l2Books.get(key)?.promise === promise) this.l2Books.delete(key);
      throw err;
    });
    this.l2Books.set(key, { promise, at: now });
    return promise;
  }

  /** Drop cached reads for a trading address after a mutating exchange call. */
  invalidateWallet(address: Hex | string): void {
    const key = address.toLowerCase();
    this.wallets.delete(key);
    this.openOrders.delete(key);
    this.userFills.delete(key);
  }

  getUserFills(
    address: Hex | string,
    fetch: () => Promise<any[]>,
  ): Promise<any[]> {
    const key = address.toLowerCase();
    const hit = this.userFills.get(key);
    if (hit) return hit.promise;
    const promise = fetch().catch((err) => {
      this.userFills.delete(key);
      throw err;
    });
    this.userFills.set(key, { promise });
    return promise;
  }

  /** Mids move continuously; invalidate after fills so sizing uses a fresh mid. */
  invalidateMids(): void {
    this.mids = null;
  }

  getWalletBundle(
    address: Hex | string,
    fetch: () => Promise<HlWalletBundle>,
  ): Promise<HlWalletBundle> {
    const key = address.toLowerCase();
    const hit = this.wallets.get(key);
    if (hit) return hit.promise;
    const promise = fetch().catch((err) => {
      this.wallets.delete(key);
      throw err;
    });
    this.wallets.set(key, { promise });
    return promise;
  }

  getOpenOrders(
    address: Hex | string,
    fetch: () => Promise<any[]>,
  ): Promise<any[]> {
    const key = address.toLowerCase();
    const hit = this.openOrders.get(key);
    if (hit) return hit.promise;
    const promise = fetch().catch((err) => {
      this.openOrders.delete(key);
      throw err;
    });
    this.openOrders.set(key, { promise });
    return promise;
  }

  getAllMids(fetch: () => Promise<Record<string, string>>): Promise<Record<string, string>> {
    if (this.mids) return this.mids.promise;
    const promise = fetch().catch((err) => {
      this.mids = null;
      throw err;
    });
    this.mids = { promise };
    return promise;
  }

  getMetaAndAssetCtxs(fetch: () => Promise<HlMetaAndAssetCtxs>): Promise<HlMetaAndAssetCtxs> {
    if (this.metaAndAssetCtxs) return this.metaAndAssetCtxs.promise;
    const promise = fetch().catch((err) => {
      this.metaAndAssetCtxs = null;
      throw err;
    });
    this.metaAndAssetCtxs = { promise };
    return promise;
  }
}
