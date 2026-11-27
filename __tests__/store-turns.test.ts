/* The store's reads of a long record let other work run (slice 2.3b): every ROWS_PER_TURN rows read into objects, a
 * timer of 0 ms queued before the read is served, so a press on the screen is never held behind a whole record. What
 * is read is the same, in the same order. */

import type { Row } from 'cashucard';
import { createSchema, createSerial, openDatabase } from '../src/till/store/db';
import { ROWS_PER_TURN, SqliteJournal } from '../src/till/store/journal';
import { fakeDisk } from './helpers/fake-sql';

type R = Record<string, unknown>;
const F = require('./fixtures/archive-rows.json') as { held: R[]; delivered: R[] };
const KEY = '12'.repeat(32);

async function journalOf(sales: number): Promise<SqliteJournal> {
  const disk = fakeDisk();
  const { driver } = await openDatabase(disk.opener, '/d', 't.db', KEY);
  await createSchema(driver);
  const j = new SqliteJournal(driver, createSerial(), () => 1000);
  const sale = F.delivered.find((x) => x.kind === 'sale')!;
  const pay = F.delivered.find((x) => x.kind === 'payment')!;
  for (let i = 0; i < sales; i += 1) {
    const id = 'a-' + i;
    await j.write({ ...sale, id: 'sale:' + id, sale: { ...(sale.sale as R), id } } as unknown as Row);
    await j.write({ ...pay, id: 'pay:' + String(i).padStart(32, '0'), sale: id } as unknown as Row);
  }
  return j;
}

/** How many times a timer queued just before `read` ran before `read` answered (0 when it did not). */
async function servedDuring(read: () => Promise<unknown>): Promise<number> {
  let served = 0;
  let going = true;
  const again = (): void => {
    if (going) {
      served += 1;
      setTimeout(again, 0);
    }
  };
  setTimeout(again, 0);
  await read();
  going = false;
  return served;
}

describe("the store's reads of a long record", () => {
  it('let a timer run every ROWS_PER_TURN rows, and read the same rows in the same order', async () => {
    expect(ROWS_PER_TURN).toBe(250);
    const j = await journalOf(600);
    expect(await servedDuring(() => j.list())).toBeGreaterThanOrEqual(3);
    expect(await servedDuring(() => j.paymentFacts())).toBeGreaterThanOrEqual(1);
    expect(await servedDuring(() => j.saleFacts())).toBeGreaterThanOrEqual(1);
    const rows = await j.list();
    expect(rows).toHaveLength(1200);
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual(['sale:a-0', 'pay:' + '0'.repeat(32)]);
    expect((await j.paymentFacts()).map((f) => f.sale)).toEqual(Array.from({ length: 600 }, (_, i) => 'a-' + i));
    expect((await j.saleFacts()).map((s) => s.id)).toEqual(Array.from({ length: 600 }, (_, i) => 'a-' + i));
  }, 60000);

  it('a short record is read in one turn', async () => {
    const j = await journalOf(100);
    expect(await servedDuring(() => j.list())).toBe(0);
  });
});
