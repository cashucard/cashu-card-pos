import {
  guardedFetch,
  MAX_BODY_BYTES,
  RedirectRefusedError,
  sameUrl,
  type RawFetch,
} from '../till/http';
import type { RedirectAnswer, RedirectFindings } from './types';

/** Asks the bench server for answers that redirect, and records what the guard and React Native's fetch did. */
export async function redirectProbe(raw: RawFetch, bench: string): Promise<RedirectFindings> {
  const b = bench.replace(/\/+$/, '');
  const GET = { method: 'GET', headers: {} as Record<string, string> };

  const reset = await raw(b + '/reset', { method: 'POST', headers: {}, body: '' });
  if (reset.status < 200 || reset.status > 299) {
    throw new Error('redirect probe: the bench server did not answer /reset');
  }

  const p = await raw(b + '/ping', GET);
  const pingUrl = typeof p.url === 'string' ? p.url : '';

  const guard = guardedFetch(raw, MAX_BODY_BYTES);
  const pingAccepted = await guard(b + '/ping', GET).then(
    () => true,
    () => false,
  );

  type Outcome = { did: 'refused' | 'accepted' | 'error'; got: RedirectAnswer | null };
  const outcome = async (call: () => Promise<unknown>): Promise<Outcome> => {
    try {
      await call();
      return { did: 'accepted', got: null };
    } catch (e) {
      if (e instanceof RedirectRefusedError) {
        return {
          did: 'refused',
          got: { status: e.status, url: e.answered, original: sameUrl(e.asked, e.answered) },
        };
      }
      return { did: 'error', got: null };
    }
  };

  const o302 = await outcome(() => guard(b + '/redirect/302', GET));
  const o307 = await outcome(() =>
    guard(b + '/redirect/307', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"probe":307}',
    }),
  );
  const guard302 = o302.did;
  const guard307post = o307.did;

  const rawOutcome = async (mode: 'error' | 'manual'): Promise<string> => {
    try {
      const r = await raw(b + '/redirect/302', { method: 'GET', headers: {}, redirect: mode });
      return 'status ' + r.status + ' at ' + (typeof r.url === 'string' && r.url !== '' ? r.url : 'no URL');
    } catch (e) {
      return 'threw: ' + (e instanceof Error ? e.message : String(e));
    }
  };

  const rawError = await rawOutcome('error');
  const rawManual = await rawOutcome('manual');

  const h = await raw(b + '/hits', GET);
  if (h.status < 200 || h.status > 299) {
    throw new Error('redirect probe: the bench server did not answer /hits');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await h.text());
  } catch {
    throw new Error('redirect probe: the bench server did not answer /hits');
  }
  const j = parsed as { landed?: unknown } | null;
  if (j === null || typeof j !== 'object' || !Array.isArray(j.landed)) {
    throw new Error('redirect probe: the bench server did not answer /hits');
  }
  const landed = j.landed;

  let landedGet = 0;
  let landedPost = 0;
  let postBodyForwarded = false;
  for (const item of landed) {
    const entry = item as { method?: unknown; bodyBytes?: unknown };
    if (entry.method === 'GET') {
      landedGet += 1;
    } else if (entry.method === 'POST') {
      landedPost += 1;
      if (typeof entry.bodyBytes === 'number' && entry.bodyBytes > 0) {
        postBodyForwarded = true;
      }
    }
  }
  const followed = landedGet + landedPost > 0;

  return {
    pingUrl,
    pingAccepted,
    guard302,
    guard307post,
    got302: o302.got,
    got307post: o307.got,
    rawError,
    rawManual,
    followed,
    landedGet,
    landedPost,
    postBodyForwarded,
  };
}

/** The one line the self-test shows for the redirect findings; throws when they are not what the shell needs. */
export function judgeRedirect(f: RedirectFindings): string {
  if (!f.pingAccepted) {
    throw new Error(
      'the guard refused a plain answer: React Native reported ' +
        (f.pingUrl === '' ? 'no answer URL' : f.pingUrl) +
        ' for /ping',
    );
  }
  if (f.guard302 !== 'refused') {
    throw new Error('a 302 was ' + f.guard302 + ' by the guard');
  }
  if (f.guard307post !== 'refused') {
    throw new Error('a 307 POST was ' + f.guard307post + ' by the guard');
  }
  // slice 2.5 (ENG-905): the phone's own network layer must not follow. A request that reached the redirect's target
  // has already left the phone, whatever the guard did with the answer afterwards.
  const target =
    'at the target: ' + f.landedGet + ' GET, ' + f.landedPost + ' POST' + (f.postBodyForwarded ? ' with its body' : '');
  if (f.followed || f.landedGet !== 0 || f.landedPost !== 0) {
    throw new Error(
      'the phone followed a redirect itself (redirect error: ' + f.rawError + '; manual: ' + f.rawManual + '); ' + target,
    );
  }
  const told = (name: string, want: number, got: RedirectFindings['got302']): string => {
    if (got === null || got.status !== want || !got.original) {
      throw new Error(
        name +
          ' reached JavaScript as ' +
          (got === null ? 'nothing' : 'status ' + got.status + ' at ' + (got.url === '' ? 'no URL' : got.url)) +
          ', not as ' +
          want +
          ' at the address asked',
      );
    }
    return String(got.status);
  };
  const s302 = told('a 302', 302, f.got302);
  const s307 = told('a 307 POST', 307, f.got307post);
  return (
    'the phone did not follow a 302 or a 307 POST: JavaScript got ' +
    s302 +
    ' and ' +
    s307 +
    ' at the address asked, and the guard refused both; ' +
    target
  );
}
