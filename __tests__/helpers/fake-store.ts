import type { StoreDeps, StoreFiles } from '../../src/till/store/types';
import { fakeDisk, type FakeDisk, type FakeDriverOptions } from './fake-sql';
import { fakeSecure, type FakeSecure } from './fake-secure';

export interface FakeFiles extends StoreFiles {
  readonly disk: FakeDisk;
  /** files that exist beside the databases (sidecars, moved files): by path */
  readonly extra: Set<string>;
  /** paths excluded from backup */
  readonly excludedPaths: Set<string>;
  /** dir() and exclude() do not exclude */
  noExclude: boolean;
  /** exists() rejects */
  failExists: boolean;
}

export function fakeFiles(disk: FakeDisk): FakeFiles {
  const extra = new Set<string>();
  const excludedPaths = new Set<string>();
  const madeDirs = new Set<string>();

  const there = (path: string): boolean =>
    disk.files.has(path) || extra.has(path) || madeDirs.has(path);

  const f: FakeFiles = {
    disk,
    extra,
    excludedPaths,
    noExclude: false,
    failExists: false,
    async dir(name: string): Promise<string> {
      const d = '/app/' + name;
      madeDirs.add(d);
      if (!f.noExclude) {
        excludedPaths.add(d);
      }
      return d;
    },
    async exists(path: string): Promise<boolean> {
      if (f.failExists) {
        throw new Error('the files cannot be read');
      }
      return disk.files.has(path) || extra.has(path);
    },
    async exclude(path: string): Promise<boolean> {
      if (!disk.files.has(path) && !extra.has(path)) {
        return false;
      }
      if (!f.noExclude) {
        excludedPaths.add(path);
      }
      return true;
    },
    async excluded(path: string): Promise<boolean> {
      return excludedPaths.has(path) && there(path);
    },
    async move(from: string, to: string): Promise<void> {
      if (disk.files.has(to) || extra.has(to)) {
        throw new Error('the target exists');
      }
      const entry = disk.files.get(from);
      if (entry !== undefined) {
        disk.files.delete(from);
        disk.files.set(to, entry);
      } else if (extra.has(from)) {
        extra.delete(from);
        extra.add(to);
      } else {
        throw new Error('nothing to move');
      }
      if (excludedPaths.has(from)) {
        excludedPaths.delete(from);
        excludedPaths.add(to);
      }
    },
    async removeLab(path: string): Promise<void> {
      const last = path.split('/').pop() ?? '';
      if (!last.startsWith('lab-')) {
        throw new Error('only a lab file can be removed');
      }
      disk.files.delete(path);
      extra.delete(path);
    },
  };
  return f;
}

export interface FakeStore {
  deps: StoreDeps;
  disk: FakeDisk;
  files: FakeFiles;
  secure: FakeSecure;
  logs: string[];
}

/** The store's device over fakes: the disk of fake-sql, the files over it, the fake secure store, a counting random
 * source (byte i of draw k is (k * 31 + i + 1) % 256), the clock at 1000. */
export function fakeStoreDeps(o: FakeDriverOptions = {}): FakeStore {
  const disk = fakeDisk(o);
  const files = fakeFiles(disk);
  const secure = fakeSecure();
  const logs: string[] = [];
  let draw = 0;
  const deps: StoreDeps = {
    files,
    secure,
    opener: disk.opener,
    randomBytes(n: number): Uint8Array {
      const k = draw;
      draw += 1;
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) {
        b[i] = (k * 31 + i + 1) % 256;
      }
      return b;
    },
    now: () => 1000,
    log: (line: string) => {
      logs.push(line);
    },
  };
  return { deps, disk, files, secure, logs };
}
