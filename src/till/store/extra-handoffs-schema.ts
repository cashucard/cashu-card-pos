// Kept separately from merchant takings. One replayable token for the owner of an extra payment.
export const EXTRA_HANDOFFS_TABLE =
  'CREATE TABLE extra_handoffs (payment_id TEXT PRIMARY KEY NOT NULL, mint TEXT NOT NULL, unit TEXT NOT NULL, amount INTEGER NOT NULL, created_at INTEGER NOT NULL, card_ref TEXT, token TEXT NOT NULL)';
