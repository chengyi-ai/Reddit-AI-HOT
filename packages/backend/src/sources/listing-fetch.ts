// Free listing reads: one retry for transient transport/upstream failures within the original deadline.
// Reads of one host go one at a time, and a host that says its rate limit is spent is not asked again
// until it said to (anonymous Reddit feeds allow about one request a minute per address).
import { setTimeout } from "node:timers/promises";
import { guardedFetch, HttpStatusError, type GuardedFetchOptions, type GuardedResponse } from "../lib/http-fetch.ts";

const RETRY_DELAY_MS = 1000;
const TRANSIENT_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

function transientTransport(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || TRANSIENT_CODES.has((error as NodeJS.ErrnoException).code ?? "")) return true;
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(transientTransport);
  return transientTransport(error.cause);
}

function youtubeFeed(input: string): boolean {
  const url = new URL(input);
  return url.protocol === "https:" && ["youtube.com", "www.youtube.com"].includes(url.hostname)
    && url.pathname === "/feeds/videos.xml" && /^UC[\w-]{22}$/.test(url.searchParams.get("channel_id") ?? "");
}

function transientResponse(input: string, res: GuardedResponse): boolean {
  // A working YouTube channel feed can intermittently return 404. Other missing URLs stay errors.
  return [500, 502, 503, 504].includes(res.status) || res.status === 404 && youtubeFeed(input) && youtubeFeed(res.url);
}

/** The host refused (429) or said its limit is spent: its sources wait until `until` without counting a failure. */
export class HostRateLimitedError extends HttpStatusError {
  readonly until: Date;
  constructor(host: string, until: Date) {
    super(429, `${host} rate limit: next request after ${until.toISOString()}`);
    this.until = until;
  }
}

const lanes = new Map<string, Promise<unknown>>();
const reopensAt = new Map<string, number>();

/** When a host that limits its rate takes requests again: Retry-After, else Reddit's x-ratelimit-reset (seconds), else a minute. */
function limitedUntil(res: GuardedResponse): number | null {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status !== 429 && (remaining === null || Number(remaining) >= 1)) return null;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const at = /^\d+$/.test(retryAfter.trim()) ? Date.now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(at)) return at;
  }
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  return Date.now() + (Number.isFinite(reset) && reset > 0 ? reset : 60) * 1000;
}

export async function fetchListing(input: string, opts: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  const host = new URL(input).hostname.toLowerCase();
  const turn = (lanes.get(host) ?? Promise.resolve()).then(() => readListing(host, input, opts));
  const settled = turn.catch(() => undefined);
  lanes.set(host, settled);
  void settled.then(() => { if (lanes.get(host) === settled) lanes.delete(host); });
  return turn;
}

async function readListing(host: string, input: string, opts: GuardedFetchOptions): Promise<GuardedResponse> {
  const closed = reopensAt.get(host);
  if (closed !== undefined && closed > Date.now()) throw new HostRateLimitedError(host, new Date(closed));
  reopensAt.delete(host);
  const res = await retryingFetch(input, opts);
  const until = limitedUntil(res);
  if (until !== null) reopensAt.set(host, until);
  if (res.status === 429) throw new HostRateLimitedError(host, new Date(until!));
  return res;
}

async function retryingFetch(input: string, opts: GuardedFetchOptions): Promise<GuardedResponse> {
  const repeatable = (opts.method ?? "GET").toUpperCase() === "GET" && opts.body === undefined;
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  for (let attempt = 0; ; attempt++) {
    const canRetry = () => repeatable && attempt === 0 && deadline - Date.now() > RETRY_DELAY_MS;
    try {
      // Listing addresses come from the source configuration, so a listed private feed host may serve them.
      const res = await guardedFetch(input, { ...opts, privateFeedHost: true, timeoutMs: Math.max(1, deadline - Date.now()) });
      if (!canRetry() || !transientResponse(input, res)) return res;
    } catch (error) {
      if (!canRetry() || !transientTransport(error)) throw error;
    }
    await setTimeout(RETRY_DELAY_MS);
  }
}
