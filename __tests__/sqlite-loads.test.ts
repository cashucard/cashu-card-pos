// The set-up's check that jest reaches Node's own SQLite, which the store's fake uses, and that it answers the way the
// fake relies on. Orders never change it.
type Param = string | number | null;
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...p: Param[]): Array<Record<string, unknown>>;
      run(...p: Param[]): { changes: number | bigint };
    };
  };
};

describe('node:sqlite under jest', () => {
  it('runs the statements the store uses', () => {
    const db = new DatabaseSync(':memory:');
    db.prepare('BEGIN IMMEDIATE').run();
    db.prepare('CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL)').run();
    db.prepare('PRAGMA user_version = 1').all();
    db.prepare('COMMIT').run();
    expect(db.prepare('PRAGMA user_version').all().map((r) => ({ ...r }))).toEqual([{ user_version: 1 }]);
    const ins = 'INSERT INTO t (id, v) VALUES (?, ?) ON CONFLICT(id) DO NOTHING';
    expect(Number(db.prepare(ins).run('a', '1').changes)).toBe(1);
    expect(Number(db.prepare(ins).run('a', '2').changes)).toBe(0);
    db.prepare('INSERT INTO t (id, v) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET v = excluded.v').run('a', '3');
    expect(db.prepare('SELECT v FROM t WHERE id = ?').all('a').map((r) => ({ ...r }))).toEqual([{ v: '3' }]);
    expect(() => db.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('b', null)).toThrow(/NOT NULL/);
  });
});
