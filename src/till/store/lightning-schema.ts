function payoutTable(name: 'lightning_payouts' | 'lightning_payouts_v5'): string {
  return `CREATE TABLE ${name} (
    id TEXT PRIMARY KEY NOT NULL,
    payment_hash TEXT UNIQUE NOT NULL,
    mint TEXT NOT NULL,
    address TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    max_fee INTEGER NOT NULL CHECK(max_fee >= 0),
    quoted_fee INTEGER NOT NULL CHECK(quoted_fee >= 0 AND quoted_fee <= max_fee),
    input_amount INTEGER NOT NULL CHECK(input_amount >= amount + max_fee),
    input_count INTEGER NOT NULL CHECK(input_count > 0),
    automatic INTEGER NOT NULL CHECK(automatic IN (0,1)),
    state TEXT NOT NULL CHECK(state IN ('quoted','submitted','paid','failed','cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    fee INTEGER CHECK(fee >= 0 AND fee <= input_amount - amount),
    plan TEXT NOT NULL
  )`;
}

const PAYOUT_INDEXES = [
  "CREATE UNIQUE INDEX lightning_active_mint ON lightning_payouts (mint) WHERE state IN ('quoted','submitted')",
  'CREATE INDEX lightning_history ON lightning_payouts (mint)',
];

// An active payout owns its input deliveries through kept.withdrawal.
export const LIGHTNING_UPGRADE = [
  'CREATE TABLE lightning_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL)',
  payoutTable('lightning_payouts'),
  ...PAYOUT_INDEXES,
  `CREATE TABLE lightning_sweeps (
    mint TEXT PRIMARY KEY NOT NULL,
    address TEXT NOT NULL,
    threshold INTEGER NOT NULL CHECK(threshold >= 0),
    max_fee INTEGER NOT NULL CHECK(max_fee >= 0)
  )`,
];

// Layout 4 stored the actual fee under a constraint that assumed every mint honored its quote.
// Preserve rowid as the history uses insertion order even if the device clock moves backwards.
const PAYOUT_COLUMNS = 'rowid,id,payment_hash,mint,address,amount,max_fee,input_amount,input_count,automatic,state,created_at,updated_at,expires_at,fee,plan';
export const LIGHTNING_FEE_UPGRADE = [
  payoutTable('lightning_payouts_v5'),
  `INSERT INTO lightning_payouts_v5 (${PAYOUT_COLUMNS},quoted_fee) SELECT ${PAYOUT_COLUMNS},max_fee FROM lightning_payouts`,
  'DROP TABLE lightning_payouts',
  'ALTER TABLE lightning_payouts_v5 RENAME TO lightning_payouts',
  ...PAYOUT_INDEXES,
];
