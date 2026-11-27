import type { Delivery } from 'cashucard';

/** walletPayout's keep: each delivery stored once by its id. Memory only in this slice. */
export interface MemoryKeep {
  readonly keep: (d: Delivery) => Promise<void>;
  /** every call, in order, duplicates included */
  readonly calls: Delivery[];
  /** one per delivery id */
  readonly stored: Map<string, Delivery>;
  /** the sum of the stored deliveries' amounts */
  total(): number;
}

/** The keep of a wallet payout, in memory: it never throws. */
export function memoryKeep(): MemoryKeep {
  const calls: Delivery[] = [];
  const stored = new Map<string, Delivery>();
  return {
    keep: async (d: Delivery): Promise<void> => {
      const copy = JSON.parse(JSON.stringify(d)) as Delivery;
      calls.push(copy);
      if (!stored.has(copy.id)) {
        stored.set(copy.id, copy);
      }
    },
    calls,
    stored,
    total(): number {
      let sum = 0;
      for (const d of stored.values()) {
        sum += d.amount;
      }
      return sum;
    },
  };
}
