import type { HttpFetch } from 'cashucard';
import { combineDeliveries, remainingWithdrawal, type WalletBalance } from '../wallet';
import type { Serial } from './db';
import { SQL } from './sql';
import type { SqlDriver } from './types';

export class WalletStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly serial: Serial,
  ) {}

  balances(): Promise<WalletBalance[]> {
    return this.serial(async () => {
      const result = await this.driver
        .run(`SELECT mint,unit,sum(available) AS available,max(id) AS id,sum(amount) AS amount,max(pending) AS pending
          FROM (
            SELECT mint_norm AS mint,unit,amount AS available,NULL AS id,0 AS amount,0 AS pending FROM kept WHERE withdrawal IS NULL
            UNION ALL SELECT mint,unit,0,id,amount,pending FROM withdrawals WHERE amount>0
          ) GROUP BY mint,unit ORDER BY mint,unit`);
      return result.rows.map((row) => ({
        mint: String(row.mint),
        unit: String(row.unit),
        available: Number(row.available),
        withdrawal:
          row.id === null
            ? null
            : { id: String(row.id), amount: Number(row.amount), pending: row.pending === 1 },
      }));
    });
  }

  prepare(mint: string, unit: string): Promise<void> {
    return this.serial(async () => {
      await this.driver.run(SQL.begin);
      try {
        const open = await this.driver.run(
          'SELECT id FROM withdrawals WHERE mint=? AND unit=? AND amount>0',
          [mint, unit],
        );
        if (!open.rows.length) {
          // Bound each share-sheet payload. Later deliveries stay available for the next withdrawal.
          const { rows } = await this.driver.run(
            'SELECT id,amount,token FROM kept WHERE mint_norm=? AND unit=? AND withdrawal IS NULL ORDER BY rowid LIMIT 64',
            [mint, unit],
          );
          if (!rows.length) throw new Error('No takings are available at this mint.');
          const batch = [];
          let chars = 0;
          for (const row of rows) {
            const token = String(row.token);
            if (batch.length && chars + token.length > 100000) break;
            batch.push({ id: String(row.id), token, amount: Number(row.amount) });
            chars += token.length;
          }
          const joined = combineDeliveries(mint, unit, batch);
          const id = batch[0].id;
          await this.driver.run(
            'INSERT INTO withdrawals (id,mint,unit,token,amount,deliveries,pending) VALUES (?,?,?,?,?,?,0)',
            [id, mint, unit, joined.token, joined.amount, batch.length],
          );
          for (const row of batch) {
            await this.driver.run('UPDATE kept SET withdrawal=? WHERE id=?', [id, row.id]);
          }
        }
        await this.driver.run(SQL.commit);
      } catch (error) {
        await this.driver.run(SQL.rollback);
        throw error;
      }
    });
  }

  async token(id: string): Promise<string> {
    const { rows } = await this.serial(() =>
      this.driver.run('SELECT token FROM withdrawals WHERE id=? AND amount>0 AND pending=0', [id]),
    );
    if (!rows.length) throw new Error('Check redemption before sharing this token.');
    return String(rows[0].token);
  }

  // The caller holds the till's export job across the network call. The compare-and-swap
  // also prevents an older reply overwriting a newer partial redemption.
  async check(id: string, http: HttpFetch): Promise<{ amount: number; pending: boolean }> {
    const { rows } = await this.serial(() => this.driver.run('SELECT * FROM withdrawals WHERE id=?', [id]));
    if (!rows.length) throw new Error('Withdrawal not found.');
    const current = rows[0];
    const amount = Number(current.amount);
    if (!amount) return { amount: 0, pending: false };
    const token = String(current.token);
    const left = await remainingWithdrawal(http, String(current.mint), String(current.unit), {
      amount,
      token,
    });
    const updated = await this.serial(() =>
      this.driver.run(
        'UPDATE withdrawals SET token=?,amount=?,pending=? WHERE id=? AND token=? AND pending=?',
        [left.token, left.amount, left.pending ? 1 : 0, id, token, current.pending],
      ),
    );
    if (updated.rowsAffected !== 1) throw new Error('This withdrawal changed. Check its current status.');
    return { amount: left.amount, pending: left.pending };
  }
}
