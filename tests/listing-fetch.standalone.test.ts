// Free listing reads: one retry after a dropped connection or an upstream 500, YouTube's intermittent
// missing feed included, and nothing else is read twice. One host is read one request at a time, and a
// host whose rate limit is spent is not asked again before it said to. Without live services or a database.
import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { after, mock, test } from "node:test";
import timersPromises from "node:timers/promises";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { fetchListing, HostRateLimitedError } from "@aihot/backend/sources/listing-fetch";
import { fetchRss } from "@aihot/backend/sources/rss";
import { fetchWebList } from "@aihot/backend/sources/web-list";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const previousDispatcher = getGlobalDispatcher();
const previousPrivate = config.allowPrivateNetworkFetch;
const previousProxy = config.egressProxyUrl;
const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
config.allowPrivateNetworkFetch = true;
config.egressProxyUrl = null;
// The pause before the retry is not what is under test.
mock.method(timersPromises, "setTimeout", async () => undefined);
syncBuiltinESMExports();
after(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  config.allowPrivateNetworkFetch = previousPrivate;
  config.egressProxyUrl = previousProxy;
  setGlobalDispatcher(previousDispatcher);
  await mockAgent.close();
});

const origin = "https://publisher.invalid";
const channelPath = "/feeds/videos.xml?channel_id=UCV03SRZXJEz-hchIAogeJOg";
const youtube = "https://www.youtube.com";
const xml = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>A new video</title><link href="https://www.youtube.com/watch?v=video"/><published>2026-10-02T19:44:06Z</published></entry></feed>';
const source = (kind: string, config: Record<string, unknown>, cursor: SourceRow["cursor"] = null) =>
  ({ id: "listing-retry", kind, config, cursor, participation_mode: "editorial" }) as SourceRow;
const dropped = (message = "Client network socket disconnected before secure TLS connection was established") =>
  Object.assign(new Error(message), { code: "ECONNRESET" });

test("RSS, HTML and JSON listings recover from a dropped connection, a second drop fails", async () => {
  for (const [kind, path, body] of [
    ["rss", "/rss.xml", xml],
    ["web_list", "/blog", '<a href="/blog/post"><h3>A new post</h3><p>October 02, 2026</p></a>'],
    ["json_list", "/items", JSON.stringify([{ title: "A new post", url: origin + "/post" }])],
  ] as const) {
    mockAgent.get(origin).intercept({ path }).replyWithError(dropped());
    mockAgent.get(origin).intercept({ path }).reply(200, body);
    const items = kind === "rss" ? (await fetchRss(source(kind, { feedUrl: origin + path }))).candidates
      : kind === "web_list" ? await fetchWebList(source(kind, { url: origin + path, parseMode: "html", itemSelector: "a:has(h3)", titleSelector: "h3", publishedAtSelector: "p", publishedAtUtcOffset: "+00:00" }))
      : await fetchJsonList(source(kind, { url: origin + path, titlePaths: ["title"], urlTemplate: "{raw:url}" }));
    assert.equal(items.length, 1, kind);
    assert.match(items[0]!.title, /^A new /);
  }
  const failure = dropped("Socket closed");
  mockAgent.get(origin).intercept({ path: "/twice" }).replyWithError(failure).times(2);
  mockAgent.get(origin).intercept({ path: "/twice" }).reply(200, "Must not be read");
  await assert.rejects(fetchListing(origin + "/twice"), (error: Error) => (error.cause as NodeJS.ErrnoException)?.code === failure.code);
  assert.equal(mockAgent.pendingInterceptors().filter(i => i.path === "/twice").length, 1);
});

test("YouTube's intermittent 404 is retried with the same validators and accepts a valid 304", async () => {
  const s = source("rss", { feedUrl: youtube + channelPath });
  mockAgent.get(youtube).intercept({ path: channelPath }).reply(200, xml, { headers: { etag: '"saved"' } });
  const first = await fetchRss(s);
  assert.equal(first.candidates.length, 1);
  s.cursor = { rss: first.validator };
  for (const status of [404, 304]) {
    mockAgent.get(youtube).intercept({ path: channelPath, headers: { "if-none-match": '"saved"' } }).reply(status, "");
  }
  const second = await fetchRss(s);
  assert.equal(second.notModified, true);
  assert.deepEqual(second.candidates, []);
  assert.equal(second.validator.etag, '"saved"');
});

test("upstream 500 is retried once, but ordinary missing URLs and access/rate refusals are read once", async () => {
  mockAgent.get(origin).intercept({ path: "/temporary" }).reply(500, "Temporary error");
  mockAgent.get(origin).intercept({ path: "/temporary" }).reply(200, "Recovered");
  assert.equal((await fetchListing(origin + "/temporary")).text(), "Recovered");
  for (const [host, path, status] of [
    [origin, "/missing", 404], [origin, "/auth", 401], [origin, "/verify", 403], ["https://refusing.invalid", "/rate", 429],
    ["https://www.youtube.com.evil.invalid", channelPath, 404], [youtube, "/watch?v=missing", 404],
  ] as const) {
    let hits = 0;
    mockAgent.get(host).intercept({ path }).reply(status, () => { hits++; return "Refused"; }).persist();
    if (status === 429) await assert.rejects(fetchListing(host + path), HostRateLimitedError);
    else assert.equal((await fetchListing(host + path)).status, status);
    assert.equal(hits, 1, host + path);
  }
});

test("a host is read one request at a time and not asked again until its spent limit resets", async () => {
  let inFlight = 0;
  let most = 0;
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url!);
    most = Math.max(most, ++inFlight);
    setImmediate(() => {
      inFlight--;
      res.writeHead(200, { "x-ratelimit-remaining": req.url === "/r/a" ? "1.0" : "0.0", "x-ratelimit-reset": "40" }).end(xml);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mockAgent.enableNetConnect(/^127\.0\.0\.1:/);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const started = Date.now();
    const [a, b, c] = await Promise.allSettled(["a", "b", "c"].map((name) => fetchListing(`${base}/r/${name}`)));
    assert.equal(most, 1);
    assert.deepEqual(paths, ["/r/a", "/r/b"]);
    assert.equal(a.status, "fulfilled");
    assert.equal(b.status, "fulfilled");
    assert.ok(c.status === "rejected" && c.reason instanceof HostRateLimitedError);
    const wait = c.reason.until.getTime() - started;
    assert.ok(wait >= 40_000 && wait < 45_000, String(wait));
  } finally {
    mockAgent.disableNetConnect();
    server.close();
  }

  // A refusal names its own wait; other hosts are not held up by it.
  const other = "https://other.invalid";
  mockAgent.get(other).intercept({ path: "/429" }).reply(429, "Too Many Requests", { headers: { "retry-after": "120" } });
  const refused = await fetchListing(other + "/429").catch((error: unknown) => error);
  assert.ok(refused instanceof HostRateLimitedError && refused.status === 429);
  assert.ok(refused.until.getTime() - Date.now() > 110_000);
  mockAgent.get(origin).intercept({ path: "/open" }).reply(200, "Open");
  assert.equal((await fetchListing(origin + "/open")).text(), "Open");
});
