import type { HttpFetch } from 'cashucard';

/** The most a mint answer may hold, in characters. */
export const MAX_BODY_BYTES = 1048576;

/** What the app sends React Native's fetch. `redirect` is read by a spec fetch; the self-test probes whether RN's does. */
export interface RawInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: 'follow' | 'error' | 'manual';
}
/** What React Native's fetch answers, as far as this file reads it. */
export interface RawResponse {
  status: number;
  url?: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}
export type RawFetch = (url: string, init: RawInit) => Promise<RawResponse>;

export class RedirectRefusedError extends Error {
  readonly asked: string;
  readonly answered: string;
  readonly status: number;
  constructor(asked: string, answered: string, status: number) {
    super(
      'refused a redirect: asked ' +
        asked +
        ', answered ' +
        (answered === '' ? 'with no URL' : answered) +
        ' (status ' +
        status +
        ')',
    );
    this.name = 'RedirectRefusedError';
    this.asked = asked;
    this.answered = answered;
    this.status = status;
    Object.setPrototypeOf(this, RedirectRefusedError.prototype);
  }
}

export class BodyTooLargeError extends Error {
  readonly url: string;
  readonly size: number;
  constructor(url: string, size: number) {
    super('refused an answer of ' + size + ' characters from ' + url);
    this.name = 'BodyTooLargeError';
    this.url = url;
    this.size = size;
    Object.setPrototypeOf(this, BodyTooLargeError.prototype);
  }
}

export class NoRouteError extends Error {
  readonly url: string;
  constructor(url: string) {
    super('no route for ' + url);
    this.name = 'NoRouteError';
    this.url = url;
    Object.setPrototypeOf(this, NoRouteError.prototype);
  }
}

/** The URL in one written form: lower-case scheme and host, no default port, a path, no fragment. */
export function normalizeUrl(u: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^#]*)(#.*)?$/.exec(u);
  if (m === null || m[2] === '') {
    return null;
  }
  const scheme = m[1].toLowerCase();
  let host = m[2].toLowerCase();
  if (scheme === 'https' && host.endsWith(':443')) {
    host = host.slice(0, -':443'.length);
  }
  if (scheme === 'http' && host.endsWith(':80')) {
    host = host.slice(0, -':80'.length);
  }
  let rest = m[3];
  if (rest === '') {
    rest = '/';
  } else if (!rest.startsWith('/')) {
    rest = '/' + rest;
  }
  return scheme + '://' + host + rest;
}

/** Whether two URLs name the same place, in whatever written form. */
export function sameUrl(a: string, b: string): boolean {
  const na = normalizeUrl(a);
  return na !== null && na === normalizeUrl(b);
}

/** A fetch that refuses any answer that was redirected, has no URL, or is too large, before the library reads it. */
export function guardedFetch(inner: RawFetch, maxBytes: number): HttpFetch {
  return async (url, init) => {
    const r = await inner(url, init);
    const answered = typeof r.url === 'string' ? r.url : '';
    if (r.status >= 300 && r.status <= 399) {
      throw new RedirectRefusedError(url, answered, r.status);
    }
    if (!sameUrl(url, answered)) {
      throw new RedirectRefusedError(url, answered, r.status);
    }
    const len = r.headers ? r.headers.get('content-length') : null;
    if (len !== null && /^\d+$/.test(len.trim()) && Number(len) > maxBytes) {
      throw new BodyTooLargeError(url, Number(len));
    }
    const text = await r.text();
    if (text.length > maxBytes) {
      throw new BodyTooLargeError(url, text.length);
    }
    return { status: r.status, text: async () => text };
  };
}

/** A fetch that sends an https mint name to its local base, by host. A URL with no route is refused. */
export function routedFetch(routes: Readonly<Record<string, string>>, inner: HttpFetch): HttpFetch {
  return async (url, init) => {
    const m = /^https:\/\/([^/?#]+)([^#]*)$/i.exec(url);
    if (m === null) {
      throw new NoRouteError(url);
    }
    const host = m[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(routes, host)) {
      throw new NoRouteError(url);
    }
    const target = routes[host].replace(/\/+$/, '') + m[2];
    return inner(target, init);
  };
}
