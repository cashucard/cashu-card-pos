/* The screens read the record and the archive in one steady reading (slice 2.3 review), over the real library, the real
 * store and the real till service: the Activity's totals, Records' counts and the payment list never count or list a
 * payment twice, or leave one out, while rows move into the archive. Slice 2.3b: each reading is asked while an archive
 * job runs, with a row already in the archive that the library has not yet taken out of the rows it read for the job
 * (cashucard 0.3.0 answers readings during the job from those rows); the reading is made in the queue after the job. */

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { activityView, readActivity } from '../src/app/activity';
import { RecordsScreen } from '../src/screens/RecordsScreen';
import { archiveTill, many, PRICE, until as untilTrue, type ArchiveTill } from './helpers/archive-till';
import { press, textOf, until } from './helpers/render';

/** The archive run is asked, and its job waits just after the store moved its 50th row: `run` (in an object, so that
 * awaiting this does not wait for the run). */
async function inJob(t: ArchiveTill): Promise<{ run: Promise<unknown> }> {
  t.after.at = 49;
  const run = t.service.archiveNow('asked');
  await untilTrue(() => t.after.waiting);
  return { run };
}

/** 'In the record now: 250 payments.' and 'Paid and archived: 700 sats in 50 payments.' as numbers */
function numbers(text: string): number[] {
  return (text.match(/[0-9][0-9,]*/g) ?? []).map((x) => Number(x.replace(/,/g, '')));
}

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

describe('the screens read steadily while the till archives', () => {
  it('an Activity reading asked during an archive job counts each payment once, today and in all', async () => {
    const t = await archiveTill(many(300), { auto: false });
    const { run } = await inJob(t);
    const reading = readActivity(t.service, () => t.clock.now);
    for (let i = 0; i < 20; i += 1) {
      await tick();
    }
    t.after.release();
    const d = await reading;
    const v = activityView(d, 1, d.at ?? t.clock.now);
    expect(v.all).toEqual({ sats: 300 * PRICE, count: 300 });
    expect(v.today).toEqual({ sats: 300 * PRICE, count: 300 });
    await run;
    await t.service.close();
  }, 60000);

  it('Activity readings repeated while an archive runs: every one counts each payment once', async () => {
    const t = await archiveTill(many(300), { auto: false });
    let done = false;
    const run = t.service.archiveNow('asked').then(() => {
      done = true;
    });
    const seen: number[] = [];
    while (!done) {
      const d = await readActivity(t.service, () => t.clock.now);
      seen.push(activityView(d, 1, d.at ?? t.clock.now).all.count);
    }
    await run;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((n) => n !== 300)).toEqual([]);
    await t.service.close();
  }, 60000);

  it('Records counts read during an archive job count each payment once', async () => {
    const t = await archiveTill(many(300), { auto: false });
    const { run } = await inJob(t);
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<RecordsScreen reader={t.service} onBack={() => undefined} />);
    });
    expect(textOf(tree, 'records-reading')).toBe('Reading the record.');
    await act(async () => {
      t.after.release();
    });
    await until(tree, 'records-live');
    const live = numbers(textOf(tree, 'records-live'))[0];
    const archived = numbers(textOf(tree, 'records-archived'));
    expect(live + archived[1]).toBe(300);
    expect(archived[0]).toBe(archived[1] * PRICE);
    await act(async () => {
      tree.unmount();
    });
    await run;
    await t.service.close();
  }, 60000);

  it('the payment list shared during an archive job lists each payment once', async () => {
    const t = await archiveTill(many(300), { auto: false });
    const shared: string[] = [];
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <RecordsScreen
          reader={t.service}
          share={async (_title, text) => {
            shared.push(text);
          }}
          onBack={() => undefined}
        />,
      );
    });
    await until(tree, 'records-live');
    const { run } = await inJob(t);
    await press(tree, 'records-share');
    await act(async () => {
      t.after.release();
    });
    for (let i = 0; i < 200 && shared.length === 0; i += 1) {
      await act(async () => {
        await tick();
      });
    }
    expect(shared).toHaveLength(1);
    const lines = shared[0].split('\r\n').filter((l) => l !== '');
    expect(lines).toHaveLength(301);
    expect(lines.filter((l) => l.endsWith(',yes')).length + lines.filter((l) => l.endsWith(',no')).length).toBe(300);
    await act(async () => {
      tree.unmount();
    });
    await run;
    await t.service.close();
  }, 60000);
});
