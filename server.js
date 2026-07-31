'use strict';

/**
 * WBAI Archive — light, zero-dependency Node server.
 *
 * Responsibilities:
 *   - Serve the static front-end from ./public
 *   - GET /api/archive     live scrape of archive2.wbai.org -> JSON (cached)
 *   - GET /api/nowplaying  proxy of the on-air / up-next feed -> JSON (cached)
 *   - GET /api/showinfo    per-show descriptions harvested from that feed
 *   - GET /pix/<file>      image proxy for show artwork (allow-listed filenames)
 *
 * No third-party dependencies: only Node's standard library plus the built-in
 * global fetch (Node 18+). This keeps the attack surface and image size small.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * Everything this server persists lives under ONE directory, and that directory
 * is named by ONE variable.
 *
 * This repo is a template other Pacifica stations deploy, so the number of
 * things an operator can get wrong is a design constraint, not a detail. One
 * `DATA_DIR` means one env var, and it is the same string as the volume's mount
 * path — there is nothing to keep in sync. The three per-file variables below
 * still work as escape hatches for anyone who needs to split the files up, but
 * DEPLOYMENT.md documents only DATA_DIR.
 *
 * Local vs production, because this is the one place a laptop cannot reproduce
 * a container (docs/admin-page.md §5.1): locally this is `./data` in the repo,
 * an ordinary directory that survives everything. In production it is a mount
 * point, and whether it survives a redeploy is a fact about the deployment that
 * only /healthz can answer. Never conclude anything about that from a local run.
 */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// Which station this deployment is. Only stamped into data files for now, so a
// volume that gets restored or attached to the wrong app is caught rather than
// silently merged. The full per-station configuration story is ROADMAP.md item 4.
const STATION_ID = process.env.STATION_ID || 'wbai';
const SHOWINFO_PATH = process.env.SHOWINFO_PATH || path.join(DATA_DIR, 'showinfo.json');
// Read-only starting set for the harvest cache, baked into the image. Lives
// outside the data dir on purpose: a mounted volume shadows whatever the image
// put at /app/data, so a seed placed there would never be seen. See the merge
// below and docs/ARCHITECTURE.md.
const SEED_PATH = process.env.SEED_PATH || path.join(__dirname, 'seed', 'showinfo.json');
const PROGRAMS_PATH = process.env.PROGRAMS_PATH || path.join(DATA_DIR, 'programs.json');
const PROGRAMS_TTL = 24 * 60 * 60 * 1000;

const UPSTREAM = {
  archive: 'https://archive2.wbai.org/',
  schedule: 'https://confessor2.wbai.org/playlist/pub_sched.php',
  nowplaying: 'https://confessor2.wbai.org/playlist/_pl_current_ary.php',
  pixBase: 'https://confessor2.wbai.org/pix/',
  programList: 'https://wbai.org/programlist/',
  program: 'https://wbai.org/program.php?program=',
  liveStream: 'https://streaming.wbai.org/wbai_verizon',
};

const CAT_MAP = {
  '12': 'arts', '15': 'health', '11': 'music', '13': 'news',
  '14': 'public-affairs', '16': 'science', '18': 'special',
};

// ---------------------------------------------------------------- utilities

function unescapeHtml(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&ensp;|&nbsp;/g, ' ')
    // soft hyphen is a line-break hint with no place in plain text, and the
    // feed sometimes truncates it to "&shy" with no semicolon
    .replace(/&shy;?/g, '')
    // typographic entities are common in the program descriptions
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    .replace(/&copy;/g, '©')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .trim();
}

/**
 * Per-host upstream health, recorded from the traffic we already make.
 *
 * Deliberately NOT a set of probe requests on a timer: WBAI runs a small Apache
 * (see FEED_CONCURRENCY) and adding synthetic pings to watch it would be adding
 * load in order to measure load. Everything here is a by-product of a request
 * the app needed anyway, so the monitoring costs nothing.
 */
const upstreamDiag = new Map();   // host -> counters below
function trackUpstream(url, startedAt, status, failed) {
  let host;
  try { host = new URL(url).host; } catch (e) { host = 'unknown'; }
  const d = upstreamDiag.get(host)
    || { ok: 0, missing: 0, fail: 0, lastMs: 0, slowestMs: 0, lastAt: 0, lastStatus: 0 };
  const ms = Date.now() - startedAt;
  d.lastMs = ms;
  d.lastAt = Date.now();
  d.lastStatus = status || 0;
  if (ms > d.slowestMs) d.slowestMs = ms;

  // A 404 is counted separately and is NOT a failure. 33 of the slugs the
  // listing advertises have no feed behind them, so `catchUpFeeds` probing them
  // 404s by design — folding that into an error count would show a permanently
  // unhealthy upstream and train everyone to ignore the panel. Only transport
  // errors, other 4xx and 5xx are faults.
  if (failed || !status) d.fail++;
  else if (status === 404) d.missing++;
  else if (status >= 400) d.fail++;
  else d.ok++;
  upstreamDiag.set(host, d);
}

async function fetchText(url, opts) {
  opts = opts || {};
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign(
        { 'User-Agent': 'wbai-archive/1.0 (+https://github.com/Catskill909/wbai-archive)' },
        opts.headers
      ),
      body: opts.body,
      signal: AbortSignal.timeout(12000),
    });
  } catch (e) {
    // A timeout or a DNS failure never reaches the line below, and that is
    // exactly the condition worth seeing on the dashboard.
    trackUpstream(url, started, 0, true);
    throw e;
  }
  trackUpstream(url, started, res.status);
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  // Most upstream pages (the listings) are declared ISO-8859-1, so latin1 is the
  // default and keeps their bytes intact. The now-playing JSON feed, however, is
  // served as UTF-8 — decoding that as latin1 turns "í" (0xC3 0xAD) into "Ã­".
  // Callers pass opts.encoding: 'utf8' for those. See docs/big-audio-bug.md family.
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString(opts.encoding || 'latin1');
}

// simple TTL cache
function makeCache(ttlMs) {
  let value = null;
  let ts = 0;
  let hits = 0;
  let misses = 0;
  return {
    get() {
      const fresh = value !== null && Date.now() - ts < ttlMs;
      if (fresh) hits++; else misses++;
      return fresh ? value : null;
    },
    set(v) { value = v; ts = Date.now(); },
    stale() { return value; },
    // A miss is an upstream request. The ratio is the difference between
    // proxying a small station politely and hammering it.
    stats() { return { hits, misses, ageMs: ts ? Date.now() - ts : 0 }; },
  };
}

// ---------------------------------------------------------- schedule photos

// altid -> numeric photo id, scraped from the schedule grid's image preloads.
async function fetchPhotoMap() {
  const html = await fetchText(UPSTREAM.schedule);
  const map = {};
  const re = /pix\/([A-Za-z0-9_]+)_med_(\d+)\.jpg/g;
  let m;
  while ((m = re.exec(html))) {
    if (!map[m[1]]) map[m[1]] = m[2];
  }
  return map;
}

// ------------------------------------------------------------ archive parse

function parseArchive(html, photoMap) {
  const rows = [];
  const startRe = /<tr name="show" id="tt_(\d+)" cat="(\d+)"\s+sho="([^"]*)" dt="(\d+)"/g;
  const starts = [];
  let m;
  while ((m = startRe.exec(html))) {
    starts.push({ id: m[1], cat: m[2], sho: m[3], dt: parseInt(m[4], 10), at: m.index });
  }
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const body = html.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : s.at + 3000);

    const titleM = body.match(/class="showtitle"[^>]*>([\s\S]*?)<\/span>/);
    const title = titleM ? unescapeHtml(titleM[1].replace(/<[^>]+>/g, '')) : '';

    const hostM = body.match(/class="host">&ensp;with ([\s\S]*?)<\/span>/);
    const host = hostM ? unescapeHtml(hostM[1]) : '';

    const dateM = body.match(/class=showdate>\s*([^<]*?)<\/span>/);
    const dateText = dateM ? unescapeHtml(dateM[1]) : '';

    const lenM = body.match(/class=showlen>([^<]*)<\/span>/);
    const length = lenM ? lenM[1].trim() : '';

    const daysM = body.match(/class="daystostay">\s*(\d+)/);
    const daysLeft = daysM ? parseInt(daysM[1], 10) : 0;

    const mp3M = body.match(/mp3="([^"]+\.mp3)"/);
    const mp3 = mp3M ? mp3M[1] : '';

    const hasRSS = body.indexOf('getrss.php') !== -1;
    const photoId = photoMap[s.sho];

    rows.push({
      id: s.id,
      // Position in archive2's own page, 0-based. Their table is not air-date
      // sorted: new recordings are appended in the order they were ingested
      // rather than merged into date position (see docs/archive-source-audit.md).
      // That append order is "most recently added to the archive", and it is what
      // the app displays by default so the two listings read alike. Sorting by
      // date is still one click away in the UI.
      ord: i,
      title,
      cat: CAT_MAP[s.cat] || 'special',
      sho: s.sho,
      dt: s.dt,
      dateText,
      length,
      daysLeft,
      host,
      mp3,
      hasRSS,
      rss: hasRSS ? `https://archive2.wbai.org/getrss.php?id=${encodeURIComponent(s.sho)}` : '',
      photo: photoId ? `/pix/${s.sho}_med_${photoId}.jpg` : '',
    });
  }
  return rows;
}

// ------------------------------------------------------------- podcast feeds

/**
 * Per-show podcast XML — the structured source that replaces the scrape wherever
 * one exists.
 *
 * Every row on archive2 whose `hasRSS` is set links a real RSS 2.0 feed at
 * `/xml/<slug>.xml`. Parsing XML beats regexing a 765 KB HTML table on every
 * axis that matters, so nothing the app publishes depends on the listing's
 * attribute order holding any more.
 *
 * **The feeds are the only content source.** An episode reaches the app if and
 * only if a feed describes it; the scrape is kept for exactly one job, which is
 * discovery — telling us which shows exist and which advertise an RSS link.
 * A feed-less show is not served from the scrape as a fallback. It is dropped.
 *
 * That is a deliberate call, and it turned out to fix a data problem for free:
 * archive2's HTML carries rows its own scheduler invented (nine weekly "A Mansion
 * for the Rat" entries running back to April, `daysLeft` climbing 0, 7, 14, 21 …).
 * Those shows have no feed, so going feed-only removed them without a date filter.
 * The phantom rows and the feed-less rows are the same rows.
 *
 * One constraint shapes the rest, and it is not a defect: a feed carries however
 * many episodes WBAI's archiver is set to publish (5, as their own page says).
 * Read what arrives; never assume a number. When they raise that setting this
 * layer picks up the extra episodes on its next run, with no code change.
 *
 * The join key is the MP3 URL, which the listing carries as `mp3` and the feed
 * carries as `<enclosure url>` and `<guid>`. It is exact — no date rounding, no
 * slug aliasing (`dn` has a feed, `demnow` does not, and they are different shows).
 */
const FEEDS_PATH = process.env.FEEDS_PATH || path.join(DATA_DIR, 'feeds.json');
// Backstop only. New episodes and newly-added feeds are picked up per-scrape by
// refreshStaleFeeds/catchUpFeeds, so this blind sweep exists purely to catch
// edits that do NOT move a feed's newest date — a corrected description, a
// re-cut episode. Six hours rather than one because it is no longer on the
// critical path for anything a listener sees, and a blind sweep is 122 requests
// where the targeted passes are usually zero.
const FEEDS_TTL = 6 * 60 * 60 * 1000;
const FEED_CONCURRENCY = 5;   // a small station's Apache. Do not raise.

// slug -> { lastModified, fetchedAt, channel:{...}, items:[...] }
const feedStore = readJsonFile(FEEDS_PATH, {});
/**
 * Feed harvest diagnostics.
 *
 * `notModified` and `failed` are cumulative since boot. On their own they are
 * close to meaningless, which was demonstrated the hard way: two consecutive
 * production deploys reported 122 and then 0, and both readings were correct.
 * A running total has no denominator — "122 unchanged" does not say out of how
 * many, and "0 unchanged" reads like a failure when it is often the opposite.
 *
 * The reason those numbers swing is upstream, and worth writing down: WBAI
 * regenerates **every** feed XML in one batch, so all 122 share a Last-Modified
 * within a few seconds of each other (measured 2026-07-30: 23:04:54–23:04:57).
 * A sweep that lands just after a regeneration therefore refetches all of them
 * and legitimately records zero 304s; a sweep a minute earlier records 122.
 * Neither is a fault, and no cumulative counter can tell you which happened.
 *
 * So `lastSweep` records one full sweep's own numbers, with the denominator
 * included. That is what the studio shows, because it is the only form of this
 * that answers a question.
 */
const feedsDiag = {
  onDisk: Object.keys(feedStore).length,
  lastHarvest: 0,
  notModified: 0,
  failed: 0,
  lastSweep: null,   // { at, asked, notModified, failed } — set by harvestFeeds
  failures: [],      // last 20 { slug, at, error } — named, so they are actionable
};
/**
 * When every held feed was last confirmed current. Drives the FEEDS_TTL sweep.
 *
 * This used to start at 0 on every boot, which meant `Date.now() - 0 > TTL` was
 * trivially true and **a full 122-feed sweep ran on every single start** — even
 * one seconds after the last. That was invisible while the data directory was
 * being wiped each deploy anyway (there was nothing to reuse), and it became
 * real waste the moment the volume started persisting: four redeploys in an
 * afternoon meant ~488 requests to WBAI's Apache, nearly all of them 304s for
 * feeds we already had and had just checked.
 *
 * `FEED_CONCURRENCY`'s comment says it plainly — this is a small station's
 * server. So restore the clock from what survived on disk: the *oldest*
 * fetchedAt we hold is, by definition, the last moment every feed was known
 * current. Conservative in the right direction (a missing or ancient timestamp
 * sweeps, which is the safe outcome), and it needs no change to the file format.
 */
let feedsHarvestedAt = (function restoreHarvestClock() {
  const times = Object.values(feedStore)
    .map((r) => (r && r.fetchedAt) || 0);
  if (!times.length || times.some((t) => !t)) return 0;
  return Math.min(...times);
})();
let feedsInFlight = null;

function cdata(block, tag) {
  const m = block.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`));
  if (!m) return '';
  return unescapeHtml((m[1] !== undefined ? m[1] : m[2]) || '');
}

function parseFeedXml(xml) {
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const head = xml.split('<item>')[0];

  const items = itemBlocks.map((b) => {
    const enc = b.match(/<enclosure\s+url="([^"]+)"(?:\s+length="(\d+)")?/);
    const pub = cdata(b, 'pubDate');
    const t = pub ? Date.parse(pub) : NaN;
    const dur = cdata(b, 'itunes:duration');
    return {
      mp3: enc ? enc[1] : cdata(b, 'guid'),
      bytes: enc && enc[2] ? parseInt(enc[2], 10) : 0,
      title: cdata(b, 'title'),
      dt: Number.isNaN(t) ? 0 : Math.floor(t / 1000),
      // iTunes duration is seconds here, but the spec also allows HH:MM:SS —
      // accept both rather than trusting one station's generator forever.
      durationSec: /^\d+$/.test(dur)
        ? parseInt(dur, 10)
        : dur.split(':').reduce((a, p) => a * 60 + (parseInt(p, 10) || 0), 0),
      desc: cdata(b, 'description'),
      category: cdata(b, 'category'),
    };
  }).filter((i) => i.mp3);

  return {
    channel: {
      title: cdata(head, 'title').replace(/^WBAI\s*[-–]\s*/, '').trim(),
      desc: cdata(head, 'description'),
      author: cdata(head, 'itunes:author'),
      image: (head.match(/<itunes:image\s+href="([^"]+)"/) || [])[1] || '',
    },
    items,
  };
}

/**
 * Conditional fetch of one feed. The feeds serve Last-Modified and honour
 * If-Modified-Since with a 0-byte 304, which makes a full sweep almost free
 * after the first one — there is no ETag and no gzip upstream, so this is the
 * whole optimisation.
 *
 * Returns the previous record unchanged on 304, on any error, and on the
 * failure mode that actually happened in July: HTTP 200 with an empty body.
 * A feed that answers 200-with-nothing must never be allowed to erase what we
 * already hold.
 */
async function fetchFeed(slug, force = false) {
  const prev = feedStore[slug];
  const headers = { 'User-Agent': 'wbai-archive/1.0 (+https://github.com/Catskill909/wbai-archive)' };
  // `force` skips the conditional request. Used when the listing has already
  // proved our copy is behind: revalidating against a Last-Modified we no longer
  // trust just earns a 304 and keeps the stale copy, which is the one outcome
  // that cannot help.
  if (!force && prev && prev.lastModified) headers['If-Modified-Since'] = prev.lastModified;

  const feedUrl = `${UPSTREAM.archive}xml/${encodeURIComponent(slug)}.xml`;
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(feedUrl, { headers, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    trackUpstream(feedUrl, startedAt, 0, true);
    throw e;
  }
  trackUpstream(feedUrl, startedAt, res.status);

  // 304: the content is unchanged, but we just *verified* that — so move
  // fetchedAt forward. It means "last confirmed current", not "last changed",
  // which is what a freshness clock needs and is the only thing this field is
  // used for (restoring feedsHarvestedAt at boot, below).
  if (res.status === 304) {
    feedsDiag.notModified++;
    return prev ? Object.assign({}, prev, { fetchedAt: Date.now() }) : prev;
  }
  if (!res.ok) return prev || null;

  const xml = Buffer.from(await res.arrayBuffer()).toString('utf8');
  if (!xml.trim()) return prev || null;

  const parsed = parseFeedXml(xml);
  if (!parsed.items.length) return prev || null;

  return {
    lastModified: res.headers.get('last-modified') || '',
    fetchedAt: Date.now(),
    channel: parsed.channel,
    items: parsed.items,
  };
}

/**
 * `full` marks a sweep of every known slug, which is what the hourly TTL counts.
 * A targeted catch-up (see `catchUpFeeds`) must NOT reset that clock, or a
 * trickle of new shows would keep postponing the sweep that refreshes everything
 * else.
 */
async function harvestFeeds(slugs, full = true, force = false) {
  // Snapshot the cumulative counters so this sweep's own numbers can be
  // reported. See feedsDiag.lastSweep below for why a running total is not
  // enough on its own.
  const before = { notModified: feedsDiag.notModified, failed: feedsDiag.failed };
  let i = 0;
  const workers = Array.from({ length: Math.min(FEED_CONCURRENCY, slugs.length) }, async () => {
    while (i < slugs.length) {
      const slug = slugs[i++];
      try {
        const rec = await fetchFeed(slug, force);
        if (rec) feedStore[slug] = rec;
      } catch (e) {
        feedsDiag.failed++;
        feedsDiag.failures.unshift({ slug, at: Date.now(), error: String(e.message || e).slice(0, 120) });
        feedsDiag.failures.length = Math.min(feedsDiag.failures.length, 20);
      }
    }
  });
  await Promise.all(workers);
  if (full) {
    feedsHarvestedAt = Date.now();
    feedsDiag.lastHarvest = feedsHarvestedAt;
    feedsDiag.lastSweep = {
      at: feedsHarvestedAt,
      asked: slugs.length,
      notModified: feedsDiag.notModified - before.notModified,
      failed: feedsDiag.failed - before.failed,
    };
  }
  writeJsonSoon(FEEDS_PATH, () => feedStore);
}

// A slug we asked for and did not get a feed for, and when. Most of these are
// permanent — as of 2026-07-29, 21 shows advertise a podcast XML button with
// nothing behind it — so without a cooldown the catch-up below would re-probe
// all of them on every 5-minute archive refresh forever.
const feedMissAt = new Map();
const FEED_MISS_RETRY_MS = 15 * 60 * 1000;
const FEED_STALE_RETRY_MS = 10 * 60 * 1000;

/**
 * Fetch feeds for shows the listing now advertises but we hold nothing for.
 *
 * Publication is gated on feeds we actually hold, so a show that *gains* a feed
 * is invisible until the next harvest — and on the hourly TTL that is up to an
 * hour of a real, listed, playable show missing from the site. That is not
 * hypothetical: WBAI added 21 feeds in a few minutes on 2026-07-29, and "Living
 * for the City" sat with five published episodes and a working feed while the
 * site showed none of them.
 *
 * So a claim we cannot satisfy is treated as a reason to go and look, rather
 * than something to wait out. Only the unknown slugs are fetched, not all ~122,
 * and each is retried at most every FEED_MISS_RETRY_MS. Awaited rather than
 * backgrounded because its whole purpose is to affect the response being built.
 */
async function catchUpFeeds(claimedSlugs) {
  const now = Date.now();
  const unknown = claimedSlugs.filter((s) => {
    const held = feedStore[s];
    if (held && held.items && held.items.length) return false;
    return now - (feedMissAt.get(s) || 0) > FEED_MISS_RETRY_MS;
  });
  if (!unknown.length) return 0;
  unknown.forEach((s) => feedMissAt.set(s, now));
  const before = Object.keys(feedStore).length;
  await harvestFeeds(unknown, false);
  const gained = Object.keys(feedStore).length - before;
  if (gained > 0) console.log(`[feeds] catch-up picked up ${gained} new feed(s) of ${unknown.length} probed`);
  return gained;
}

/**
 * Refresh only the feeds that demonstrably have something new.
 *
 * The scrape we already do every 5 minutes carries each show's newest air date.
 * A feed whose newest `<item>` is at least as recent as that cannot be hiding a
 * new episode from us, so asking about it is pure waste — and it is nearly all
 * of them: measured 2026-07-29, 121 of 122 feeds were already current, so this
 * fetches **zero** on a typical pass against 122 for a blind sweep.
 *
 * That is what makes a 5-minute cadence affordable. A blind conditional sweep
 * every 5 minutes is 35,000 requests a day at WBAI (cheap per request — 16.7 KB
 * for all 122, every one a 304 — but 35,000 of them); this is a few hundred, and
 * a new episode's feed data lands on the very next scrape instead of up to an
 * hour later.
 *
 * The full sweep stays as a slow backstop: this comparison only notices changes
 * that move a feed's newest date, so a corrected description or a re-cut episode
 * would be missed without it.
 */
async function refreshStaleFeeds(rows) {
  const newestByShow = new Map();
  for (const r of rows) {
    const cur = newestByShow.get(r.sho);
    if (cur === undefined || r.dt > cur) newestByShow.set(r.sho, r.dt);
  }

  const stale = [];
  for (const [slug, rec] of Object.entries(feedStore)) {
    if (!rec || !rec.items || !rec.items.length) continue;
    const scraped = newestByShow.get(slug);
    if (scraped === undefined) continue;
    const feedNewest = rec.items.reduce((m, i) => Math.max(m, i.dt || 0), 0);
    if (scraped > feedNewest) stale.push(slug);
  }

  if (!stale.length) return 0;
  // A feed can sit behind the listing for a while quite legitimately — the row
  // appears as soon as the recording lands, the feed rebuilds afterwards. Without
  // a cooldown that gap would be re-fetched on every 5-minute scrape, and a feed
  // that never catches up would be re-fetched forever.
  const now = Date.now();
  const due = stale.filter((s) => now - (feedMissAt.get(s) || 0) > FEED_STALE_RETRY_MS);
  if (!due.length) return 0;
  due.forEach((s) => feedMissAt.set(s, now));
  await harvestFeeds(due, false, true);
  console.log(`[feeds] refreshed ${due.length} feed(s) the listing showed as behind: ${due.join(', ')}`);
  return due.length;
}

// MP3 URL -> the feed item describing it, rebuilt from whatever the store holds.
function feedIndex() {
  const byMp3 = new Map();
  for (const [slug, rec] of Object.entries(feedStore)) {
    if (!rec || !rec.items) continue;
    for (const it of rec.items) byMp3.set(it.mp3, { slug, item: it, channel: rec.channel });
  }
  return byMp3;
}

/**
 * Feed-only: an episode reaches the app if and only if a podcast feed describes
 * it. Anything the feeds do not carry is dropped.
 *
 * This is a deliberate product decision, not a technical limit — the scraped row
 * for a feed-less show is still perfectly good data, and an earlier design served
 * it as a fallback. It is dropped anyway, so that everything the app publishes
 * came from structured XML and the HTML scrape can never silently become the
 * source of a user-visible episode again.
 *
 * The scrape keeps exactly one job: **discovery**. It tells us which shows exist
 * and which of them carry an RSS link. It no longer supplies content.
 *
 * The visible cost, measured 2026-07-29: 540 scraped rows in, ~356 out. The
 * shortfall is not lost data — it is 88 rows from 40 feed-less shows, plus older
 * episodes of feed-having shows that fall outside however many items each feed
 * publishes. Both recover on their own as WBAI adds feeds and raises the
 * per-feed item count; nothing here needs changing when they do.
 */
/**
 * Reject recordings too short to be a broadcast.
 *
 * An earlier version of this tested the START TIME — anything not on the :00 or
 * :30 grid was treated as a recorder restart. That was wrong, and it dropped
 * real content: "Living for the City" aired 2026-07-29 at 11:13 am and ran
 * 45m45s, a complete programme that simply started fourteen minutes late.
 * Democracy Now has done the same at 8:07 am for 52 minutes.
 *
 * Duration is the honest test. WBAI's shortest scheduled format is 30 minutes —
 * across 543 episodes the floor for a normal broadcast is 1802s (CounterSpin,
 * ReelWorld, Economic Update all sit exactly there) and there is a clean gap
 * with NOTHING between 5 and 15 minutes. So 20 minutes sits in empty space: well
 * under anything WBAI schedules, well over the fragments (3m31s, 4m28s), and it
 * does not depend on when the recorder happened to start.
 *
 * KNOWN COST — split recordings. When the recorder fails mid-programme and
 * resumes, one broadcast lands as two rows, and a short first half is
 * indistinguishable by length from a fragment. Three such splits exist as of
 * 2026-07-29:
 *
 *   Katie Halper   Jul 22  15:00 1044s + 15:17 2508s   <- first half dropped
 *   Radio Free E.  Jun 14  11:00 1500s + 11:24 2096s   both kept
 *   In Other News  Jun  5  03:00 1566s + 03:27 1958s   both kept
 *
 * So the floor currently costs exactly one segment: 17 minutes of Katie Halper.
 * Accepted deliberately — the alternative is publishing 3-minute fragments as
 * though they were episodes. If it ever costs more, the better fix is to detect
 * the pattern rather than lower the number: two rows for the same `sho` on the
 * same day, the second starting within a few minutes of where the first ended,
 * is a split and both halves should be kept whatever their length.
 */
const MIN_EPISODE_SEC = 20 * 60;

function hmsToSec(hms) {
  const p = String(hms || '').split(':').map((n) => parseInt(n, 10));
  if (p.length !== 3 || p.some(Number.isNaN)) return 0;
  return p[0] * 3600 + p[1] * 60 + p[2];
}

function applyFeeds(rows) {
  const byMp3 = feedIndex();
  // Shows we actually hold a working feed for. NOT `row.hasRSS` — that is only
  // archive2's *claim* that a feed exists, and on 2026-07-29 the claim went
  // wrong: rows for `manrat` began rendering a podcast XML button while
  // `/xml/manrat.xml` still answered 404, which let all 14 generated
  // "A Mansion for the Rat" rows back into the listing. Trust the fetch, not the
  // markup. `hasRSS` still decides which slugs are worth *asking* for.
  const haveFeed = new Set(
    Object.entries(feedStore)
      .filter(([, rec]) => rec && rec.items && rec.items.length)
      .map(([slug]) => slug)
  );

  const kept = [];
  let droppedNoFeed = 0;
  let droppedFragment = 0;

  for (const r of rows) {
    // The gate is per SHOW, not per episode.
    //
    // The distinction matters and got it wrong once: gating per *episode* also
    // deleted 89 older episodes of shows whose feeds are perfectly healthy,
    // purely because a feed publishes only its most recent 5. Those episodes are
    // real, listed, and playable — the 5 is a display setting on WBAI's side, not
    // a statement about what exists.
    if (!haveFeed.has(r.sho)) { droppedNoFeed++; continue; }
    // 0 means the listing gave no parseable length; keep it rather than guess.
    const secs = hmsToSec(r.length);
    if (secs && secs < MIN_EPISODE_SEC) { droppedFragment++; continue; }

    const hit = byMp3.get(r.mp3);
    if (!hit) {
      // Inside the feed's window we use the feed; outside it we keep the listing
      // row as-is. `source` makes which one visible rather than inferred, so the
      // share of the catalogue still riding on the scrape is a number we can read
      // — and one that shrinks on its own as WBAI raises the per-feed item count.
      kept.push(Object.assign({}, r, { source: 'listing' }));
      continue;
    }

    const it = hit.item;
    kept.push(Object.assign({}, r, {
      source: 'feed',
      feedSlug: hit.slug,
      // The listing still supplies identity — id, dt, daysLeft, category and the
      // schedule artwork have no equivalent in the feed, and mp3/dt are the join
      // itself, so they are never overwritten.
      durationSec: it.durationSec || 0,
      bytes: it.bytes || 0,
      // Per-episode text, kept only when it says something the show blurb doesn't.
      episodeDesc: it.desc && it.desc !== hit.channel.desc ? it.desc : '',
      host: r.host || hit.channel.author || '',
    }));
  }

  return { rows: kept, droppedNoFeed, droppedFragment };
}

// 5 minutes. A re-scrape costs ~950 KB from upstream and ~2 ms of parse, so the
// tighter window is cheap; what it buys is that a show posted just after a scrape
// surfaces in about five minutes instead of ten.
const archiveCache = makeCache(5 * 60 * 1000);

// Shared promise for a scrape that is currently running. Without it, every
// request arriving during a cache miss starts its own upstream fetch — and since
// open tabs poll /api/archive/head on the same 5-minute cycle as the TTL, misses
// arrive in clusters. One flight per miss, no matter how many callers.
let archiveInFlight = null;

async function getArchive() {
  const cached = archiveCache.get();
  if (cached) return cached;
  if (archiveInFlight) return archiveInFlight;

  archiveInFlight = (async () => {
    const [html, photoMap] = await Promise.all([
      fetchText(UPSTREAM.archive),
      fetchPhotoMap().catch(() => ({})),
    ]);
    const scraped = parseArchive(html, photoMap);
    if (!scraped.length) throw new Error('parsed zero rows');

    // Discovery is the scrape's only remaining job: it names the shows that
    // advertise an RSS link, and that list drives the harvest. Refreshed on the
    // feed TTL rather than the archive's, so a 5-minute re-scrape doesn't pull
    // 98 feeds with it.
    const feedSlugs = [...new Set(scraped.filter((r) => r.hasRSS).map((r) => r.sho))];
    if (Date.now() - feedsHarvestedAt > FEEDS_TTL) {
      if (!feedsInFlight) {
        feedsInFlight = harvestFeeds(feedSlugs)
          .catch((e) => console.warn('[feeds] harvest failed:', e.message))
          .finally(() => { feedsInFlight = null; });
      }
      // The very first harvest is awaited — serving a feed-only listing from an
      // empty feed store would publish zero episodes. Later refreshes run in the
      // background off whatever is already held.
      if (!Object.keys(feedStore).length) await feedsInFlight;
    }

    // Two targeted passes, both driven off the scrape we just did and both
    // typically fetching nothing at all. Between them a new episode's feed data
    // lands on the next 5-minute refresh rather than waiting for the sweep.
    //
    //   catchUpFeeds     — shows that gained a feed since the last sweep, which
    //                      would otherwise be absent from the site entirely
    //   refreshStaleFeeds — shows whose feed is behind what the listing shows
    await catchUpFeeds(feedSlugs);
    await refreshStaleFeeds(scraped);

    const { rows, droppedNoFeed, droppedFragment } = applyFeeds(scraped);
    // A total wipe means the feed store is empty or the join key changed shape —
    // never a real editorial state. Fail, so the request handler falls back to
    // the last good payload instead of publishing an empty archive.
    if (!rows.length) throw new Error('feed join produced zero rows');

    // `latest` (newest air date) plus `count` is the freshness signature the client
    // polls via /api/archive/head — an episode added moves `latest`, one aging out
    // of the retention window moves `count`.
    const latest = rows.reduce((max, r) => Math.max(max, r.dt), 0);
    const payload = {
      updated: Date.now(),
      count: rows.length,
      latest,
      scraped: scraped.length,
      droppedNoFeed,
      droppedFragment,
      feeds: Object.keys(feedStore).length,
      shows: rows,
    };
    archiveCache.set(payload);
    return payload;
  })();

  // Only the caller that started the flight clears it; joiners took the early
  // return above. A rejection propagates to every joiner, which is what we want —
  // they all fall through to the stale-cache path in the request handler.
  try {
    return await archiveInFlight;
  } finally {
    archiveInFlight = null;
  }
}

// ---------------------------------------------------------- show info cache

/**
 * WBAI exposes rich per-show fields (description, host, links, artwork) only for
 * the show that is on air and the one up next — there is no bulk endpoint for
 * them. So every now-playing poll donates its two records to this map, keyed by
 * the same altid the archive rows carry, and coverage fills in as the schedule
 * rotates. It is a cache, never a source of truth: if the file cannot be read or
 * written the server simply runs on whatever it has learned since boot.
 */
// Both on-disk caches (this one and the program directory) read and write through
// these two helpers; a failure on either side is logged once and ignored, so an
// unwritable data dir only costs the cache, never the request.
function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : fallback;
  } catch (e) {
    // A truncated file lands here and is silently discarded, which is right for
    // a cache but would be invisible for anything that matters — so say it out
    // loud when the file exists and simply didn't parse.
    if (e instanceof SyntaxError) {
      console.warn(`[cache] ${path.basename(file)} is unreadable, starting empty:`, e.message);
    }
    return fallback;
  }
}

/**
 * Write JSON so that a crash can never leave a half-written file.
 *
 * `writeFileSync` straight over the live file truncates it first: a crash, a
 * full disk or a container killed mid-write leaves valid-looking bytes that are
 * not valid JSON, and `readJsonFile` above then throws the whole file away at
 * the next boot. Harmless for a cache we can re-fetch — but the same helper is
 * what a month of analytics counters will use (docs/admin-page.md §5.5), and
 * that is not re-fetchable. Write to a sibling temp file, fsync it, then rename:
 * rename is atomic within a filesystem, so a reader sees the old file or the new
 * one and never a partial one.
 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    // Without this the rename can be durable while the contents are not.
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

const saveTimers = new Map();
const savePending = new Map();   // file -> getData, for the shutdown flush
function writeJsonSoon(file, getData, delayMs = 10000) {
  savePending.set(file, getData);
  if (saveTimers.has(file)) return;
  const t = setTimeout(() => flushFile(file), delayMs);
  // Deliberately unref'd: a pending cache write must not hold the process open.
  // That is also precisely why flushOnExit() below exists — see its comment.
  if (t.unref) t.unref();
  saveTimers.set(file, t);
}

function flushFile(file) {
  const timer = saveTimers.get(file);
  if (timer) clearTimeout(timer);
  saveTimers.delete(file);
  const getData = savePending.get(file);
  if (!getData) return;
  savePending.delete(file);
  try {
    writeJsonAtomic(file, getData());
  } catch (e) {
    console.warn(`[cache] ${path.basename(file)} running memory-only:`, e.message);
  }
}

/**
 * Flush every queued write before the process goes away.
 *
 * `writeJsonSoon` debounces by ten seconds and unrefs its timer, so until now a
 * shutdown inside that window simply dropped the write. Locally that is invisible
 * — you restart by hand, rarely mid-debounce, and the data dir is the same one
 * either way. In production it happens on EVERY redeploy: Coolify stops the
 * container with SIGTERM, and Node's default action for an unhandled SIGTERM is
 * to exit immediately. Ten seconds of harvest was lost each time, which nobody
 * noticed because the caches refill themselves.
 *
 * The analytics rollups planned in docs/admin-page.md §5.5 are the reason this
 * is now a bug worth fixing rather than a curiosity: those counters cannot be
 * re-derived from anywhere, and "we lose whatever happened since the last flush,
 * on every deploy" is not an acceptable property for them.
 *
 * Synchronous on purpose. There is no time budget to negotiate with here — the
 * writes are a few hundred KB and the alternative is racing the SIGKILL that
 * follows.
 */
let shuttingDown = false;
function flushOnExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const files = [...savePending.keys()];
  if (files.length) console.log(`[storage] flushing ${files.length} pending write(s) before exit`);
  files.forEach(flushFile);
  if (signal) {
    // Restore the default disposition rather than calling process.exit(), so the
    // exit status is the one the supervisor expects from a signalled process.
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
}
process.on('SIGTERM', () => flushOnExit('SIGTERM'));
process.on('SIGINT', () => flushOnExit('SIGINT'));
// Covers the ordinary "ran out of work and exited" path, which no signal fires for.
process.on('beforeExit', () => flushOnExit(null));

const showInfo = readJsonFile(SHOWINFO_PATH, {});
let showInfoUpdated = Object.keys(showInfo).length ? Date.now() : 0;

/**
 * Boot-time storage facts, reported by /healthz.
 *
 * Whether a persistent volume is actually mounted at the data dir is otherwise
 * only answerable by watching a redeploy and inferring from record counts. These
 * are captured *before* the seed merge below, so they describe what genuinely
 * survived on disk rather than what the seed has just put in memory.
 */
const storageDiag = {
  dataDir: DATA_DIR,
  // records read out of the data dir at boot; >0 means a previous run's cache
  // outlived its container, which is exactly what a working volume looks like
  showinfoOnDisk: Object.keys(showInfo).length,
  writable: false,
  bootedAt: Date.now(),
  // filled in by probeMount() below: is anything mounted here at all, and if so
  // what. null means "couldn't tell" (no /proc — i.e. not Linux), not "no".
  mounted: null,
  volume: null,
  anonymousVolume: null,
  // filled in by identifyVolume() below
  instanceId: null,
  persistedSince: 0,
  freshVolume: true,
};
(function probeDataDir() {
  const probe = path.join(DATA_DIR, '.write-probe');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(probe, String(Date.now()));
    storageDiag.writable = true;
  } catch (e) {
    console.warn('[storage] data dir is not writable, caches are memory-only:', e.message);
  } finally {
    try { fs.unlinkSync(probe); } catch (e) { /* nothing to clean up */ }
  }
})();

/**
 * Give the volume an identity, so "is persistent storage actually working?" is
 * something production can be ASKED rather than inferred.
 *
 * `showinfoOnDisk` was the previous answer and it is a weak one: it counts
 * records, and a count can be non-zero or zero for reasons that have nothing to
 * do with the mount. This writes one small file the first time it sees an empty
 * data dir and never touches it again. Two fields then settle the question from
 * outside, with no waiting and no reasoning:
 *
 *   persistedSince  older than this process => the directory outlived a deploy
 *   instanceId      unchanged across a deploy => it is the SAME directory
 *
 * The second one is the load-bearing check. Docker's `VOLUME` instruction with
 * no explicit mount silently creates a fresh anonymous volume per container, so
 * data appears to persist right up until the next deploy — the exact symptom
 * this deployment showed on 2026-07-26 (CLAUDE.md §4). A changed instanceId
 * names that failure instead of leaving it to be deduced.
 *
 * And the reason it has to be measured in production at all: locally none of
 * this can fail. `./data` is an ordinary directory that survives every restart
 * because there is no container boundary to survive. A local pass proves the
 * code runs, never that the storage works. See docs/admin-page.md §5.1.
 */
/**
 * Ask the kernel whether anything is actually mounted at DATA_DIR.
 *
 * The instance marker below is the authoritative check, but it is inherently
 * retrospective: it can only tell you the directory survived *a previous
 * deploy*, so the first deploy after configuring a volume proves nothing — an
 * empty new volume and no volume at all look identical from inside. That is a
 * miserable feedback loop for a template someone is standing up for the first
 * time.
 *
 * /proc/self/mountinfo answers the other half immediately. If DATA_DIR is not a
 * mount point, it is the container's own writable layer and the data is
 * guaranteed to be discarded — knowable on deploy number one, with no history.
 * And when it IS a mount, the source path usually names the Docker volume,
 * which is how an *anonymous* volume gets caught: Docker names those with 64
 * hex characters, and an anonymous volume is the failure this project actually
 * had (see the Dockerfile's note about the removed `VOLUME` line).
 *
 * Best-effort by design. Linux-only — there is no /proc on macOS, so a local
 * run reports `null`, which is the honest answer rather than a misleading one.
 * The mount source is also not guaranteed to carry the volume name on every
 * storage driver. Nothing here is load-bearing: a null or unrecognised result
 * means "ask the instance marker instead", never "something is wrong".
 */
// `info` is injectable so the parser can be tested off a Linux box — there is no
// /proc on macOS, and shipping an unverified parser to production to find out is
// exactly the habit this project has rules about. See test/storage/.
function probeMount(dir, info) {
  const out = { mounted: null, volume: null, anonymousVolume: null };
  if (info === undefined) {
    try {
      info = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    } catch (e) {
      return out;   // not Linux, or /proc not visible. Unknown, not false.
    }
  }
  out.mounted = false;
  for (const line of info.split('\n')) {
    const f = line.split(' ');
    if (f.length < 5) continue;
    // fields: id parent major:minor root mountPoint ... (spaces are \040-escaped)
    const mountPoint = f[4].replace(/\\040/g, ' ');
    if (mountPoint !== dir) continue;
    out.mounted = true;
    const m = f[3].match(/\/volumes\/([^/]+)\/_data/);
    if (m) {
      out.volume = m[1];
      // Docker names anonymous volumes with a 64-char hex id. A human-chosen
      // name is what a configured, persistent mount looks like.
      out.anonymousVolume = /^[0-9a-f]{64}$/.test(m[1]);
    }
  }
  return out;
}
Object.assign(storageDiag, probeMount(DATA_DIR));

const INSTANCE_PATH = path.join(DATA_DIR, '.instance.json');
(function identifyVolume() {
  if (!storageDiag.writable) return;
  const prev = readJsonFile(INSTANCE_PATH, null);
  if (prev && prev.id) {
    storageDiag.instanceId = prev.id;
    storageDiag.persistedSince = prev.firstBoot || 0;
    storageDiag.freshVolume = false;
    return;
  }
  // No marker. That means either a genuinely empty data dir, or a volume that
  // predates this code — and the difference matters, because the deploy that
  // introduces the marker would otherwise report `freshVolume:true` on a
  // perfectly healthy volume and send someone chasing a bug that isn't there.
  // Existing cache files are the evidence: they were written by an earlier run,
  // so the directory demonstrably survived one. Date the volume from the oldest
  // of them rather than from now.
  const inherited = [SHOWINFO_PATH, PROGRAMS_PATH, FEEDS_PATH]
    .map((f) => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } })
    .filter(Boolean);
  const rec = {
    id: crypto.randomUUID(),
    firstBoot: inherited.length ? Math.round(Math.min(...inherited)) : Date.now(),
    station: STATION_ID,
  };
  try {
    writeJsonAtomic(INSTANCE_PATH, rec);
    storageDiag.instanceId = rec.id;
    storageDiag.persistedSince = rec.firstBoot;
    storageDiag.freshVolume = inherited.length === 0;
  } catch (e) {
    console.warn('[storage] could not write the instance marker:', e.message);
  }
})();

/**
 * The storage report, in one place because it has two consumers — public
 * /healthz and the studio — and they must not drift.
 *
 * They already did, immediately: the studio sent `storageDiag` wholesale and so
 * reported "undefined feeds", because `feedsOnDisk` lives on feedsDiag and only
 * /healthz knew to go and get it. The tests missed it (they assert the fields
 * exist, and a missing field is simply absent from JSON); a screenshot of the
 * rendered page caught it in a second. Hence one function.
 */
function storageReport() {
  return {
    dataDir: storageDiag.dataDir,
    writable: storageDiag.writable,
    mounted: storageDiag.mounted,
    volume: storageDiag.volume,
    anonymousVolume: storageDiag.anonymousVolume,
    instanceId: storageDiag.instanceId,
    persistedSince: storageDiag.persistedSince,
    bootedAt: storageDiag.bootedAt,
    freshVolume: storageDiag.freshVolume,
    showinfoOnDisk: storageDiag.showinfoOnDisk,
    showinfoNow: Object.keys(showInfo).length,
    feedsOnDisk: feedsDiag.onDisk,
  };
}

// One line in the log that answers "where is this station's data and is it
// sticking?" — the question every new deploy of this template raises, and the
// one nobody knows to go looking for until it has already cost them.
console.log(
  `[storage] ${DATA_DIR} — ${storageDiag.writable ? 'writable' : 'NOT WRITABLE'}, ` +
  (storageDiag.mounted === false
    ? 'NO VOLUME MOUNTED (container layer only — everything here dies with this container), '
    : storageDiag.anonymousVolume
      ? `ANONYMOUS VOLUME ${storageDiag.volume.slice(0, 12)}… (replaced on every deploy — configure a named mount), `
      : storageDiag.volume ? `volume "${storageDiag.volume}", ` : '') +
  (storageDiag.freshVolume
    ? 'fresh (no previous data found; on a redeploy this means the volume did NOT persist)'
    : `persisting since ${new Date(storageDiag.persistedSince).toISOString()} (instance ${storageDiag.instanceId})`)
);

/**
 * A show's record can only be harvested while that show is on the air, so a
 * server that has just booted knows almost nothing: two records, and a weekly
 * show it missed is a week away from coming round again. That is fine on a
 * long-lived box and miserable on a fresh deploy, where every info sheet would
 * be blank until the schedule had rotated all the way through.
 *
 * So the image ships a seed of what we have already learned. It is strictly a
 * floor, never an override: a field harvested from the live feed always wins,
 * because it is newer than anything baked into the image.
 */
(function seedShowInfo() {
  const seed = readJsonFile(SEED_PATH, null);
  if (!seed) return;
  let added = 0, filled = 0;
  for (const [altid, rec] of Object.entries(seed)) {
    if (!rec || typeof rec !== 'object') continue;
    const live = showInfo[altid];
    if (!live) { showInfo[altid] = Object.assign({}, rec); added++; continue; }
    // Known show, but the live record may be thinner than the seed (a poll that
    // caught it without a description, say). Fill the gaps, touch nothing else.
    for (const [k, v] of Object.entries(rec)) {
      if (k !== 'seen' && v && !live[k]) { live[k] = v; filled++; }
    }
  }
  if (added || filled) {
    showInfoUpdated = Date.now();
    console.log(`[showinfo] seeded ${added} record(s), filled ${filled} field(s) from ${path.basename(SEED_PATH)}`);
    saveShowInfoSoon();
  }
})();

/**
 * Records harvested before descriptions were flattened still hold raw HTML.
 * A show's record is only rewritten when it rotates back through the on-air
 * slot, which for a weekly show is a week away — so the cache is normalised
 * once at boot instead. Idempotent: re-running it on clean data changes
 * nothing and writes nothing.
 */
(function normaliseShowInfo() {
  let dirty = false;
  for (const rec of Object.values(showInfo)) {
    if (!rec || typeof rec !== 'object') continue;
    for (const [field, fn] of [['desc', htmlToText], ['shortdesc', htmlToText],
                               ['name', unescapeHtml], ['dj', unescapeHtml]]) {
      if (!rec[field]) continue;
      const cleaned = fn(rec[field]);
      if (cleaned !== rec[field]) { rec[field] = cleaned; dirty = true; }
    }
  }
  if (dirty) {
    showInfoUpdated = Date.now();
    console.log('[showinfo] normalised cached records to plain text');
    saveShowInfoSoon();
  }
})();

function saveShowInfoSoon() {
  writeJsonSoon(SHOWINFO_PATH, () => showInfo);
}

function clean(s) {
  return typeof s === 'string' ? s.trim() : '';
}

// Artwork arrives either as a full upstream URL or a bare filename; both become
// a path on our own /pix proxy. WBAI.png is the generic station fallback some
// records carry instead of real art, and has no _med_ id, so it drops out here.
function pixPath(candidates) {
  for (const c of candidates) {
    const m = clean(c).match(/([A-Za-z0-9_]+_med_\d+\.jpg)/);
    if (m) return '/pix/' + m[1];
  }
  return '';
}

function recordShowInfo(sh) {
  const altid = clean(sh && sh.sh_altid);
  if (!altid) return;
  // These arrive as HTML, not text: descriptions carry <br> and typographic
  // entities, and names carry entities alone. The front end renders everything
  // with textContent/esc(), so anything not flattened here reaches the sheet as
  // literal "&ldquo;" and "<br>". Same treatment the program directory gets.
  const next = {
    name: unescapeHtml(sh.sh_name),
    dj: unescapeHtml(sh.sh_djname),
    desc: htmlToText(sh.sh_desc),
    shortdesc: htmlToText(sh.sh_shortdesc),
    url: clean(sh.sh_url),
    facebook: clean(sh.sh_facebook),
    photo: pixPath([sh.sh_med_photo, sh.sh_photo]),
  };
  // empty fields are dropped rather than stored, so a show that loses its
  // description upstream keeps the copy we already have
  Object.keys(next).forEach(k => { if (!next[k]) delete next[k]; });
  if (!Object.keys(next).length) return;

  const prev = showInfo[altid];
  const changed = !prev || Object.keys(next).some(k => prev[k] !== next[k]);
  if (!changed) return;
  showInfoUpdated = Date.now();
  showInfo[altid] = Object.assign({}, prev, next, { seen: showInfoUpdated });
  saveShowInfoSoon();
}

// --------------------------------------------- per-show detail, on demand

/**
 * archive2 answers a per-show record for the dropdown on its own listing page,
 * keyed by the same altid the archive rows carry — and unlike the on-air feed it
 * answers for *any* show, not only whichever one happens to be broadcasting.
 * That lifts the constraint the harvest above is built around: a description no
 * longer has to be caught while its show is live.
 *
 * Quirks, all verified — see docs/UPSTREAM.md:
 *   - POST only. A GET replies with the literal string "bad".
 *   - The body is base64 of a small HTML table, not JSON.
 *   - An unknown altid replies with an empty body.
 *
 * Fetched lazily, when a visitor actually opens a show's sheet, rather than
 * sweeping all ~150 programmes up front — one small request that a real person
 * asked for is a far politer thing to send a small station's server.
 */
const DETAIL_RETRY_MS = 6 * 60 * 60 * 1000;
const detailTried = new Map();     // altid -> ts of last attempt, misses included
const detailInFlight = new Map();  // altid -> shared promise, one flight per altid

function parseShowDetail(html) {
  const pick = (cls) => {
    const m = html.match(new RegExp(`<td[^>]*class="${cls}"[^>]*>([\\s\\S]*?)</td>`));
    return m ? htmlToText(m[1]) : '';
  };
  // `dj` rather than `producer` so the record matches the shape the on-air feed
  // and the front end already share
  return { desc: pick('info_stmt'), dj: pick('info_producer') };
}

async function fetchShowDetail(altid) {
  const body = await fetchText(`${UPSTREAM.archive}_pa_get_show_info.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `sh_altid=${encodeURIComponent(altid)}`,
  });
  const raw = body.trim();
  if (!raw) return null;                       // unknown altid: empty reply
  const html = Buffer.from(raw, 'base64').toString('utf8');
  if (!html.includes('info_table')) return null;
  const next = parseShowDetail(html);
  Object.keys(next).forEach(k => { if (!next[k]) delete next[k]; });
  return Object.keys(next).length ? next : null;
}

/**
 * Resolves to the record for `altid`, fetching it if we have nothing useful.
 * Never overwrites a field already held: the on-air feed carries strictly more
 * (artwork, links, short description), so anything it has taught us outranks
 * this. Failures and genuine no-description shows are both remembered for
 * DETAIL_RETRY_MS so opening such a sheet repeatedly doesn't re-ask upstream.
 */
async function getShowDetail(altid) {
  const held = showInfo[altid];
  if (held && held.desc) return held;

  const tried = detailTried.get(altid) || 0;
  if (Date.now() - tried < DETAIL_RETRY_MS) return held || null;
  if (detailInFlight.has(altid)) return detailInFlight.get(altid);

  const flight = (async () => {
    let found = null;
    try {
      found = await fetchShowDetail(altid);
    } catch (e) {
      console.warn(`[detail] ${altid} lookup failed:`, e.message);
    }
    detailTried.set(altid, Date.now());
    if (!found) return showInfo[altid] || null;

    const prev = showInfo[altid];
    const merged = Object.assign({}, found, prev);   // prev wins on every clash
    if (!prev || Object.keys(found).some(k => !prev[k])) {
      showInfoUpdated = Date.now();
      showInfo[altid] = Object.assign(merged, { seen: showInfoUpdated });
      saveShowInfoSoon();
    }
    return showInfo[altid];
  })();

  detailInFlight.set(altid, flight);
  try {
    return await flight;
  } finally {
    detailInFlight.delete(altid);
  }
}

// ------------------------------------------------------- program directory

/**
 * wbai.org publishes a program page per show — host, description, website,
 * Facebook and Twitter — and /programlist/ enumerates all of them. Unlike the
 * on-air feed this covers the whole schedule, so it is where the info sheet gets
 * its host and description from for shows that are not currently on air.
 *
 * Keyed by a normalised title, because the archive rows have no program id: the
 * only thing the two systems share is the show's name.
 */
const programCache = readJsonFile(PROGRAMS_PATH, { updated: 0, programs: {} });
let programsRefreshing = false;

function normTitle(s) {
  return unescapeHtml(String(s || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Strips markup to readable text. The description blocks on these pages contain
// list markup — and, on some of them, an injected third-party <script> — so tags
// are removed here and the result is only ever rendered as text.
function htmlToText(html) {
  return unescapeHtml(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, ' ')
      .replace(/<li[^>]*>/gi, ' · ')
      .replace(/<[^>]+>/g, '')
  ).replace(/\s+/g, ' ').trim().slice(0, 1500);
}

function httpUrl(s) {
  const v = clean(s);
  return /^https?:\/\//i.test(v) ? v : '';
}

// One row per program: id, title and "Hosted by …" up to the separator image.
function parseProgramList(html) {
  const out = [];
  const re = /<a href="\.\.\/program\.php\?program=(\d+)"[^>]*>([\s\S]*?)<\/a>\s*<\/strong>\s*<br\s*\/?>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html))) {
    const title = htmlToText(m[2]);
    if (!title) continue;
    const hostPart = m[3].split(/<img/i)[0];
    out.push({
      id: m[1],
      title,
      host: htmlToText(hostPart).replace(/^hosted by:?\s*/i, ''),
    });
  }
  return out;
}

function parseProgramPage(html) {
  const pick = (re) => { const m = html.match(re); return m ? m[1] : ''; };
  return {
    title: htmlToText(pick(/<span class="pagetitle">([\s\S]*?)<\/span>/i)),
    airs: htmlToText(pick(/<hr[^>]*>\s*<p>([\s\S]*?)<\/p>/i)),
    host: htmlToText(pick(/class="hostname"[^>]*>\s*<strong>([\s\S]*?)<\/strong>/i)).replace(/^hosted by:?\s*/i, ''),
    url: httpUrl(pick(/<b>\s*Web Site:\s*<\/b>\s*<a\s+href=\s*"([^"]+)"/i)),
    facebook: httpUrl(pick(/<b>\s*Facebook:\s*<\/b>\s*<a\s+href=\s*"([^"]+)"/i)),
    twitter: httpUrl(pick(/<b>\s*Twitter:\s*<\/b>\s*<a\s+href=\s*"([^"]+)"/i)),
    desc: htmlToText(pick(/<div class=['"]description['"][^>]*>([\s\S]*?)<\/div>/i)),
  };
}

// Small worker pool: 149 pages once a day is nothing, but they still go out a
// few at a time rather than all at once.
async function mapPool(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx]); } catch (e) { results[idx] = null; }
    }
  });
  await Promise.all(workers);
  return results;
}

async function refreshPrograms() {
  if (programsRefreshing) return;
  programsRefreshing = true;
  try {
    const listing = parseProgramList(await fetchText(UPSTREAM.programList));
    if (!listing.length) throw new Error('parsed zero programs');

    const pages = await mapPool(listing, 4, async (p) => {
      const detail = parseProgramPage(await fetchText(UPSTREAM.program + encodeURIComponent(p.id)));
      return Object.assign({}, p, detail, { title: detail.title || p.title, host: detail.host || p.host });
    });

    const programs = {};
    pages.forEach((p, idx) => {
      const src = p || listing[idx];       // keep list-only data if a page failed
      const key = normTitle(src.title);
      if (!key) return;
      const rec = {};
      ['title', 'host', 'desc', 'airs', 'url', 'facebook', 'twitter'].forEach((k) => {
        if (clean(src[k])) rec[k] = clean(src[k]);
      });
      programs[key] = rec;
    });

    programCache.programs = programs;
    programCache.updated = Date.now();
    writeJsonSoon(PROGRAMS_PATH, () => programCache, 1000);
    console.log(`[programs] directory refreshed: ${Object.keys(programs).length} shows`);
  } catch (e) {
    console.warn('[programs] refresh failed, keeping cache:', e.message);
  } finally {
    programsRefreshing = false;
  }
}

// Refresh in the background: a cold cache never blocks a request, it just means
// the first visitors see the sheet without a description.
function refreshProgramsIfStale() {
  if (Date.now() - (programCache.updated || 0) < PROGRAMS_TTL) return;
  refreshPrograms();
}

// --------------------------------------------------------------- nowplaying

const nowCache = makeCache(15 * 1000); // 15 seconds

async function getNowPlaying() {
  const cached = nowCache.get();
  if (cached) return cached;
  // Match the official pl_current1.php exactly: it POSTs an empty body to this
  // endpoint (HTTP.blocking_post with post_data=[]) rather than GETting it.
  const text = await fetchText(UPSTREAM.nowplaying, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
    // This feed is served charset=UTF-8; decode it as such (not the latin1 default)
    // so accented names like "Mongo Santamaría" don't arrive as mojibake.
    encoding: 'utf8',
  });
  const data = JSON.parse(text);
  // data[0] is a station configuration block rather than schedule data, and is
  // treated as sensitive: never read, never forwarded, never logged.
  const cur = (data[1] && data[1].current) || {};
  const nxt = (data[2] && data[2].next) || {};
  recordShowInfo(cur);
  recordShowInfo(nxt);
  // rewrite the upstream photo URL to our own image proxy path
  let photo = '';
  const pm = (cur.sh_photo || '').match(/pix\/([A-Za-z0-9_]+_med_\d+\.jpg)/);
  if (pm) photo = `/pix/${pm[1]}`;
  const payload = {
    updated: Date.now(),
    current: {
      // all free-text fields come HTML-encoded from the feed (e.g. What&#039;s);
      // unescapeHtml also trims, so the client can render them with textContent
      name: unescapeHtml(cur.sh_name),
      dj: unescapeHtml(cur.sh_djname),
      // The key every description in /api/showinfo is filed under. Forwarded so
      // the live player's "About this show" panel can look up the prose and the
      // links for whatever is on air — the same join the archive sheet does,
      // which until now had no way to name the on-air show.
      altid: clean(cur.sh_altid),
      // The playlist feed carries whatever track is on air — for any show, music
      // or talk (an intro song, a bed, a clip). Forwarded so the live player can
      // show a now-playing line, and cleared the moment the feed clears it.
      song: unescapeHtml(cur.pl_song),
      artist: unescapeHtml(cur.pl_artist),
      start: cur.cur_start || '',
      end: cur.cur_end || '',
      photo,
    },
    next: {
      name: unescapeHtml(nxt.sh_name),
      start: nxt.nxt_start || '',
      end: nxt.nxt_end || '',
    },
  };
  nowCache.set(payload);
  return payload;
}

// -------------------------------------------------- live stream reachability

// When the live stream fails to start, the browser hands the page an opaque
// MediaError: it cannot tell "WBAI's streaming server is down" from "your VPN /
// firewall / flaky wifi ate it". This probe answers that question from the
// server side — one short GET, body cancelled the instant the headers land, so
// we never actually pull stream audio. Cached briefly because a failing player
// can ask more than once (and several tabs may ask at the same moment).
const liveStatusCache = makeCache(5000);

async function probeLiveStream() {
  const cached = liveStatusCache.get();
  if (cached) return cached;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  let out;
  try {
    const upstream = await fetch(UPSTREAM.liveStream, {
      headers: {
        'User-Agent': 'wbai-archive/1.0 (+https://github.com/Catskill909/wbai-archive)',
        // ask for a token amount; icecast may ignore it, hence the cancel below
        'Range': 'bytes=0-1',
      },
      signal: ctrl.signal,
    });
    // never drain the stream — headers are the whole answer
    if (upstream.body) upstream.body.cancel().catch(() => {});
    out = {
      ok: upstream.ok || upstream.status === 206,
      status: upstream.status,
      type: upstream.headers.get('content-type') || '',
      checked: Date.now(),
    };
  } catch (e) {
    out = {
      ok: false,
      status: 0,
      reason: e.name === 'AbortError' || e.name === 'TimeoutError' ? 'timeout' : 'unreachable',
      checked: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
  liveStatusCache.set(out);
  return out;
}

// ------------------------------------------------------------- image proxy

const PIX_RE = /^[A-Za-z0-9_]+_med_\d+\.jpg$/;

async function proxyPix(file, res) {
  if (!PIX_RE.test(file)) { res.writeHead(400); return res.end('bad image name'); }
  try {
    const upstream = await fetch(UPSTREAM.pixBase + file, {
      headers: { 'User-Agent': 'wbai-archive/1.0' },
      signal: AbortSignal.timeout(12000),
    });
    if (!upstream.ok) { res.writeHead(upstream.status); return res.end(); }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      ...securityHeaders(),
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502); res.end('image upstream error');
  }
}

// ------------------------------------------------------------ static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // browsers reject a manifest served as octet-stream, so this entry is required
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data:",
      "media-src 'self' https://streaming.wbai.org https://stream.wbai.org https://archive2.wbai.org",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      // The Donate button embeds WBAI's real donate page in an iframe. Without
      // this it falls under `default-src 'self'` and the browser refuses the
      // frame outright ("Refused to load ... neither the frame-src directive
      // nor the default-src directive"), leaving the modal blank. The child
      // document's own subresources (its fonts, etc.) are governed by its
      // origin, not ours — CSP does not inherit across a cross-origin frame.
      "frame-src https://docs.pacifica.org",
      "frame-ancestors 'self'",
      "base-uri 'self'",
    ].join('; '),
  };
}

/**
 * Source files must revalidate rather than sit in the browser's cache on a
 * timer. There is no build step here, so there are no content-hashed filenames:
 * `app.js` is always `app.js`, and a bare `max-age` on it means a deploy keeps
 * serving the *previous* build out of disk cache until the timer runs out, with
 * nothing to make that visible — the page looks current because `index.html`
 * revalidated, while the behaviour is a version behind. This shipped once and
 * cost an afternoon of debugging a feature that was never actually loaded.
 *
 * `no-cache` does not mean "don't cache" — it means "ask first". The answer is
 * a 304 with no body, so the cost is one conditional request. Only assets whose
 * contents can't change under a stable name keep a real TTL.
 */
const REVALIDATE = { '.html': 1, '.js': 1, '.css': 1, '.json': 1, '.webmanifest': 1 };

function notFound(req, res, filePath) {
  // SPA-ish fallback to index for unknown non-asset routes. Anything with an
  // extension is a genuine miss — and index.html always has one, so the retry
  // below can never recurse.
  if (path.extname(filePath)) { res.writeHead(404); return res.end('not found'); }
  sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'), '.html');
}

// NEVER-STALE GUARDRAIL. app.js/styles.css have no build hash, so a browser can
// keep running a previous version — this cost us hours of "fixes" that were never
// actually loaded. Fix: version each asset URL by its own mtime+size, and serve
// the HTML that references them with `no-store` so it is always fresh and always
// points at the current versions. A changed file => changed URL => guaranteed
// fetch. `serveStatic` already strips the `?v=` query when resolving the file.
function fileVer(relFromPublic) {
  try {
    const s = fs.statSync(path.join(PUBLIC_DIR, relFromPublic));
    return s.size.toString(16) + '-' + Math.round(s.mtimeMs).toString(36);
  } catch (e) { return '0'; }
}
// Combined stamp for the whole client bundle — exposed on /healthz and the
// X-App-Version header so a deploy can be verified from the command line.
function appVersion() {
  return `${fileVer('/app.js')}.${fileVer('/styles.css')}.${fileVer('/theme-boot.js')}`
    + `.${fileVer('/track.js')}`;
}
// The studio's own assets, reported separately rather than folded into
// appVersion(). A studio-only change must be visible on /healthz — otherwise
// "the version didn't move, so the old image is still serving" (the rule in
// DEPLOYMENT.md) would fire falsely on every studio deploy. Keeping them apart
// also leaves appVersion()'s meaning — the listener bundle — unchanged.
function studioVersion() {
  return `${fileVer('/studio.js')}.${fileVer('/studio.css')}`;
}

/**
 * Version-stamp every local stylesheet and script reference in an HTML document.
 *
 * This used to be three literal string replacements, one per known file, which
 * worked precisely as long as nobody added a fourth. The studio adds two, and a
 * missed stamp is not a small bug here: it is the never-stale guarantee (§1 of
 * CLAUDE.md) silently not applying to the newest code in the repo — the exact
 * failure that has cost this project the most time.
 *
 * Only same-origin paths are touched. An absolute URL does not start with `/`,
 * so it never matches, and a path that already carries a query is skipped
 * rather than double-stamped.
 */
const LOCAL_ASSET_RE = /(href|src)="(\/[A-Za-z0-9._\/-]+\.(?:css|js))"/g;
function stampAssets(html) {
  return html.replace(LOCAL_ASSET_RE, (m, attr, file) => `${attr}="${file}?v=${fileVer(file)}"`);
}

// ------------------------------------------------- link previews (OpenGraph)
// The share sheet's thumbnail is not something navigator.share() can supply: iOS
// (and Messages, Mail, Slack, WhatsApp…) builds the card by fetching the shared
// URL and reading its <head>. A `?show=<id>` link therefore has to arrive with
// that episode's artwork already in the HTML — no client-side code runs in a
// preview fetch, so nothing app.js does can add it afterwards.
const OG_RE = /<!-- og:start -->[\s\S]*?<!-- og:end -->/;
const OG_DEFAULT_TITLE = 'WBAI 99.5 FM Archive';
const OG_DEFAULT_DESC = "Search, stream, and browse WBAI 99.5 FM's on-demand broadcast archive — Free Speech Radio, Pacifica Radio in New York City.";

function htmlAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Crawlers want absolute URLs, and we are behind a proxy in production, so the
// origin has to come from the request rather than a hardcoded host.
function originFor(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return /^[A-Za-z0-9.\-:[\]]+$/.test(host) ? `${proto}://${host}` : '';
}

function ogTags(req, reqUrl) {
  const origin = originFor(req);
  const abs = (p) => (/^https?:/i.test(p) ? p : origin + p);
  let title = OG_DEFAULT_TITLE;
  let desc = OG_DEFAULT_DESC;
  let image = abs('/assets/icon-512.png');
  let pageUrl = origin + '/';

  const q = reqUrl.indexOf('?');
  const id = q === -1 ? '' : new URLSearchParams(reqUrl.slice(q + 1)).get('show');
  if (id) {
    // Read-only on whatever the archive cache already holds; the request handler
    // warms it before we get here, and a cold miss just falls back to the
    // station card rather than blocking a preview fetch on an upstream scrape.
    const data = archiveCache.get() || archiveCache.stale();
    const row = data && data.shows.find((r) => r.id === id);
    if (row) {
      const info = showInfo[row.sho] || {};
      const photo = row.photo || info.photo || '';
      title = row.title;
      // Same precedence as the info sheet's artwork, so the card matches the
      // page the recipient lands on.
      if (photo) image = abs(photo);
      desc = (info.desc || info.shortdesc || '').replace(/\s+/g, ' ').trim();
      if (desc.length > 300) desc = desc.slice(0, 297).trimEnd() + '…';
      if (!desc) desc = (row.dateText ? row.dateText + ' · ' : '') + OG_DEFAULT_TITLE;
      pageUrl = origin + '/?show=' + encodeURIComponent(id);
    }
  }

  // summary, not summary_large_image: WBAI's artwork is square (400×400), and a
  // wide card would letterbox it into a sliver.
  return [
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${htmlAttr(OG_DEFAULT_TITLE)}">`,
    `<meta property="og:title" content="${htmlAttr(title)}">`,
    `<meta property="og:description" content="${htmlAttr(desc)}">`,
    `<meta property="og:image" content="${htmlAttr(image)}">`,
    `<meta property="og:image:alt" content="${htmlAttr(title)}">`,
    `<meta property="og:url" content="${htmlAttr(pageUrl)}">`,
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${htmlAttr(title)}">`,
    `<meta name="twitter:description" content="${htmlAttr(desc)}">`,
    `<meta name="twitter:image" content="${htmlAttr(image)}">`,
  ].join('\n');
}

function injectOg(html, req, reqUrl) {
  return OG_RE.test(html) ? html.replace(OG_RE, () => ogTags(req, reqUrl)) : html;
}

function sendFile(req, res, filePath, ext) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res, filePath);
    // HTML is the freshness anchor: never cached, and its asset links carry the
    // current version stamps so app.js/styles.css can never be served stale.
    if (ext === '.html') {
      fs.readFile(filePath, 'utf8', (e2, html) => {
        if (e2) return notFound(req, res, filePath);
        const body = Buffer.from(injectOg(stampAssets(html), req, req.url || '/'), 'utf8');
        res.writeHead(200, {
          'Content-Type': MIME['.html'],
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
          'X-App-Version': appVersion(),
          ...securityHeaders(),
        });
        return res.end(body);
      });
      return;
    }
    const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(36)}"`;
    const validators = {
      'ETag': etag,
      'Last-Modified': st.mtime.toUTCString(),
      'Cache-Control': REVALIDATE[ext] ? 'no-cache' : 'public, max-age=86400',
      ...securityHeaders(),
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, validators);
      return res.end();
    }
    fs.readFile(filePath, (e2, buf) => {
      if (e2) return notFound(req, res, filePath);
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        ...validators,
      });
      res.end(buf);   // Node drops the body itself when the request was a HEAD
    });
  });
}

function serveStatic(req, reqPath, res) {
  let rel = decodeURIComponent(reqPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // resolve safely inside PUBLIC_DIR
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  sendFile(req, res, filePath, path.extname(filePath));
}

function sendJson(res, obj, status = 200, cacheSeconds = 0) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    ...securityHeaders(),
  });
  res.end(JSON.stringify(obj));
}

// ------------------------------------------------------------- usage stats
/**
 * What the station learns about its own audience — and deliberately, the least
 * that answers the question.
 *
 * The design constraint is not technical. WBAI is listener-funded, so the
 * honest position is that we can say exactly what is counted in three sentences
 * and have them be true:
 *
 *   - **Counters only. There is no event log.** A request increments a number
 *     in memory and is dropped. Nothing per-visit is written, so there is no
 *     raw history to leak, subpoena, or regret keeping.
 *   - **No identifier of any kind.** No cookie, no session, no fingerprint, no
 *     stored or hashed IP. Nothing links two events to the same person, which
 *     means "unique listeners" is not a number this app can produce — and that
 *     is a deliberate trade, not an oversight.
 *   - **No search terms.** How many searches happen is a count; what someone
 *     typed is something a person wrote. On a community station a rare query
 *     can identify one listener, so only the volume is recorded. Flipping
 *     TRACK_SEARCH_TERMS below is the whole change if that is ever revisited —
 *     and it should be revisited as a policy decision, not a code tidy.
 *
 * Rollups are plain JSON per month under $DATA_DIR/stats/. A month is a few KB;
 * keep them forever. This is the first data this app has held that no upstream
 * can hand back, which is why it waited for the volume to be *proven* rather
 * than assumed (docs/admin-page.md §5).
 */
/**
 * Collection can be switched off entirely, per station, without touching code —
 * the template rule (see desktop/src-tauri/stations/README.md). A station that
 * wants to count nothing sets USAGE_TRACKING=off and the ingest route is never
 * registered, so beacons meet the same 405 as any other stray POST and no
 * counter is ever created. Viewing is separate: that is the studio's password.
 */
const USAGE_TRACKING = (process.env.USAGE_TRACKING || 'on').toLowerCase() !== 'off';
const TRACK_SEARCH_TERMS = false;
const STATS_DIR = path.join(DATA_DIR, 'stats');
const STATS_FLUSH_MS = 60 * 1000;
const EVENT_TYPES = ['pageview', 'play', 'live', 'search', 'share'];

function statsMonthPath(month) { return path.join(STATS_DIR, `${month}.json`); }
function today() { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return today().slice(0, 7); }

let statsMonth = thisMonth();
let statsStore = readJsonFile(statsMonthPath(statsMonth), null)
  || { station: STATION_ID, month: statsMonth, days: {} };

function statsDay() {
  // Month rollover: flush what we hold, then start the new file. Checked on
  // write rather than on a timer, so a server that is idle across midnight
  // still lands the next event in the right month.
  const m = thisMonth();
  if (m !== statsMonth) {
    flushFile(statsMonthPath(statsMonth));
    statsMonth = m;
    statsStore = readJsonFile(statsMonthPath(m), null)
      || { station: STATION_ID, month: m, days: {} };
  }
  const d = today();
  if (!statsStore.days[d]) {
    statsStore.days[d] = { pageviews: 0, plays: 0, live: 0, searches: 0, shares: 0, byShow: {} };
  }
  return statsStore.days[d];
}

function saveStatsSoon() {
  writeJsonSoon(statsMonthPath(statsMonth), () => statsStore, STATS_FLUSH_MS);
}

/**
 * Abuse ceiling for the public ingest route.
 *
 * Keyed by a hash of the client address salted with a value generated fresh at
 * boot and never written anywhere — so the key cannot be reversed to an address,
 * cannot be correlated across restarts, and does not survive the process. It
 * exists only to stop one client inflating the station's own numbers.
 */
const EV_SALT = crypto.randomBytes(16);
const evSeen = new Map();
const EV_MAX_PER_MIN = 120;

function evAllowed(req) {
  const key = crypto.createHmac('sha256', EV_SALT).update(clientIp(req)).digest('base64');
  const now = Date.now();
  const rec = evSeen.get(key);
  if (!rec || now - rec.at > 60000) { evSeen.set(key, { at: now, n: 1 }); }
  else if (rec.n >= EV_MAX_PER_MIN) return false;
  else rec.n++;
  if (evSeen.size > 5000) {
    for (const [k, v] of evSeen) if (now - v.at > 60000) evSeen.delete(k);
  }
  return true;
}

async function ingestEvent(req, res) {
  // Answer the same way regardless — a beacon is fire-and-forget, and telling a
  // client whether its event counted is information nobody needs and a probe
  // nobody should get.
  const done = () => { res.writeHead(204, securityHeaders()); res.end(); };
  if (!evAllowed(req)) return done();

  let body;
  try { body = JSON.parse(await readBody(req, 512)); } catch (e) { return done(); }
  if (!body || EVENT_TYPES.indexOf(body.t) < 0) return done();

  const day = statsDay();
  switch (body.t) {
    case 'pageview': day.pageviews++; break;
    case 'live': day.live++; break;
    case 'share': day.shares++; break;
    case 'search':
      day.searches++;
      if (TRACK_SEARCH_TERMS && typeof body.q === 'string') {
        day.terms = day.terms || {};
        const q = body.q.toLowerCase().trim().slice(0, 40);
        if (q) day.terms[q] = (day.terms[q] || 0) + 1;
      }
      break;
    case 'play': {
      day.plays++;
      // The client sends the media URL it is actually playing; the slug is
      // resolved HERE against the feed index we already hold. That keeps the
      // tracker ignorant of the app's internals — it never has to know which
      // show is loaded — and means a URL we cannot resolve is simply an
      // unattributed play rather than a guess.
      const hit = typeof body.u === 'string' ? feedIndex().get(body.u) : null;
      if (hit) day.byShow[hit.slug] = (day.byShow[hit.slug] || 0) + 1;
      break;
    }
  }
  saveStatsSoon();
  return done();
}

/** Recent days, newest last, plus the totals the dashboard leads with. */
function usageReport(days = 30) {
  const out = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    const rec = (d.slice(0, 7) === statsMonth ? statsStore.days[d] : null)
      || (readJsonFile(statsMonthPath(d.slice(0, 7)), { days: {} }).days || {})[d]
      || null;
    out.push({
      day: d,
      pageviews: rec ? rec.pageviews : 0,
      plays: rec ? rec.plays : 0,
      live: rec ? rec.live : 0,
      searches: rec ? rec.searches : 0,
      shares: rec ? rec.shares : 0,
    });
  }
  const byShow = new Map();
  for (const [d, rec] of Object.entries(statsStore.days)) {
    if (!rec || !rec.byShow) continue;
    for (const [slug, n] of Object.entries(rec.byShow)) {
      byShow.set(slug, (byShow.get(slug) || 0) + n);
    }
  }
  const titles = feedStore;
  return {
    since: Object.keys(statsStore.days).sort()[0] || today(),
    month: statsMonth,
    searchTermsRecorded: TRACK_SEARCH_TERMS,
    days: out,
    totals: out.reduce((t, d) => ({
      pageviews: t.pageviews + d.pageviews,
      plays: t.plays + d.plays,
      live: t.live + d.live,
      searches: t.searches + d.searches,
      shares: t.shares + d.shares,
    }), { pageviews: 0, plays: 0, live: 0, searches: 0, shares: 0 }),
    topShows: [...byShow.entries()]
      .map(([slug, plays]) => ({
        slug,
        title: (titles[slug] && titles[slug].channel && titles[slug].channel.title) || slug,
        plays,
      }))
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 12),
  };
}

// -------------------------------------------------------------- the studio
/**
 * A password-gated area at /studio for the people who run the station. See
 * docs/admin-page.md for the whole design; the load-bearing decisions are:
 *
 *   - **Unset password means the feature does not exist.** Not "returns 403" —
 *     the routes are not registered at all, so /studio falls through to the
 *     normal SPA fallback and is indistinguishable from any other unknown path.
 *     That is the right default for a template other stations fork, and it
 *     means a misconfigured deploy leaks nothing, not even the existence of a
 *     login form.
 *   - **Sessions are a signed cookie, with no server-side store.** This app's
 *     persistence was unreliable for months (CLAUDE.md §4) and a session table
 *     on a volume that may not be mounted would log people out at random.
 *     Recomputing an HMAC needs no storage and survives a restart.
 *   - **The key is derived from the password** unless STUDIO_SECRET overrides
 *     it, which buys revocation for free: changing the password invalidates
 *     every live session. With one shared password and no user list, that is
 *     the only revocation mechanism there is, so it should be the obvious one.
 */
const STUDIO_PASSWORD = process.env.STUDIO_PASSWORD || '';
const STUDIO_ENABLED = STUDIO_PASSWORD.length > 0;
const STUDIO_SESSION_HOURS = Number(process.env.STUDIO_SESSION_HOURS) || 12;
const STUDIO_DIR = path.join(__dirname, 'admin');
const STUDIO_COOKIE = 'studio';

// Domain-separated so this key can never collide with some other use of the
// same secret later.
const studioKey = crypto.createHash('sha256')
  .update('wbai-studio-session\0' + (process.env.STUDIO_SECRET || STUDIO_PASSWORD))
  .digest();

if (STUDIO_ENABLED && STUDIO_PASSWORD.length < 12) {
  // Loud, because a short shared password on a public URL is the whole security
  // model failing quietly. Not fatal: refusing to boot would take the listener
  // app down over an admin setting, which is a worse trade.
  console.warn(`[studio] STUDIO_PASSWORD is ${STUDIO_PASSWORD.length} characters. ` +
    'Use 12+ — this is one shared secret on a public URL.');
}
console.log(STUDIO_ENABLED
  ? `[studio] enabled at /studio (sessions last ${STUDIO_SESSION_HOURS}h)`
  : '[studio] disabled — set STUDIO_PASSWORD to enable');
console.log(USAGE_TRACKING
  ? '[usage] counting plays and page views (no identifiers, no search terms)'
  : '[usage] disabled — USAGE_TRACKING=off, nothing is counted');

// Says whether this boot inherited a usable harvest clock, i.e. whether it is
// about to re-fetch 122 feeds from a small station's server or skip them.
console.log(feedsHarvestedAt
  ? `[feeds] ${Object.keys(feedStore).length} held, all confirmed current ${Math.round((Date.now() - feedsHarvestedAt) / 60000)}m ago — full sweep due in ${Math.max(0, Math.round((FEEDS_TTL - (Date.now() - feedsHarvestedAt)) / 60000))}m`
  : '[feeds] no usable harvest clock on disk — a full sweep will run');

/** Constant-time compare of two strings of any length. Hashing first equalises
 *  the lengths, so this leaks neither the password nor how long it is. */
function secretEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function studioSign(exp) {
  return crypto.createHmac('sha256', studioKey).update(String(exp)).digest('base64url');
}

function studioIssue() {
  const exp = Date.now() + STUDIO_SESSION_HOURS * 3600 * 1000;
  return `${exp}.${studioSign(exp)}`;
}

function studioValid(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const dot = raw.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(raw.slice(0, dot));
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  // Compare through the same hashing helper: the signature is attacker-supplied,
  // so a naive === would leak how many leading bytes were right.
  return secretEquals(raw.slice(dot + 1), studioSign(exp));
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq < 1) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

function studioAuthed(req) {
  return STUDIO_ENABLED && studioValid(parseCookies(req.headers.cookie)[STUDIO_COOKIE]);
}

/**
 * Login rate limiting.
 *
 * One shared password is guessable at volume, so the login route needs a brake.
 * In memory on purpose: it resets on restart (acceptable) and adds no storage
 * dependency (important — see the note about sessions above).
 *
 * The client address comes from X-Forwarded-For, which is only trustworthy
 * because this app is always deployed behind a proxy that sets it (Coolify's
 * Traefik). Read directly from the socket instead and every request on
 * production would look like it came from the proxy, bucketing the entire
 * internet into one counter — one attacker could then lock out everybody.
 */
const loginFails = new Map();   // ip -> { n, until }
const LOGIN_FREE_TRIES = 2;     // typos shouldn't cost a wait
const LOGIN_MAX_WAIT_MS = 15 * 60 * 1000;

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

function loginWaitMs(ip) {
  const rec = loginFails.get(ip);
  if (!rec) return 0;
  return Math.max(0, rec.until - Date.now());
}

function noteLoginFail(ip) {
  const rec = loginFails.get(ip) || { n: 0, until: 0 };
  rec.n++;
  const over = Math.max(0, rec.n - LOGIN_FREE_TRIES);
  rec.until = Date.now() + (over ? Math.min(2 ** over * 1000, LOGIN_MAX_WAIT_MS) : 0);
  loginFails.set(ip, rec);
  // An unbounded map keyed by attacker-controlled input is a memory-exhaustion
  // vector, so prune expired entries once it gets large.
  if (loginFails.size > 5000) {
    const now = Date.now();
    for (const [k, v] of loginFails) if (v.until <= now) loginFails.delete(k);
  }
}

/** Read a small request body, refusing anything larger. The login route is the
 *  only thing in this server that accepts a body at all. */
function readBody(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); return reject(new Error('body too large')); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Studio responses must never be cached by a browser, a back-button, or
// Traefik. `Vary: Cookie` says the response depends on who is asking, which is
// what makes a shared cache safe even in principle.
function sendStudioJson(res, obj, status = 200, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'private, no-store',
    'Vary': 'Cookie',
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendStudioHtml(req, res, file) {
  fs.readFile(path.join(STUDIO_DIR, file), 'utf8', (err, html) => {
    if (err) {
      console.error(`[studio] cannot read ${file}:`, err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('studio unavailable');
    }
    // stampAssets, so the studio's own CSS/JS get the same never-stale
    // guarantee the listener app has. Without it these files sit in the browser
    // cache under a stable name — CLAUDE.md §1, the most expensive bug here.
    const body = Buffer.from(stampAssets(html), 'utf8');
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Content-Length': body.length,
      'Cache-Control': 'private, no-store',
      'Vary': 'Cookie',
      'X-App-Version': appVersion(),
      ...securityHeaders(),
    });
    res.end(body);
  });
}

async function studioPost(req, res, pathOnly) {
  if (pathOnly === '/api/studio/logout') {
    return sendStudioJson(res, { ok: true }, 200, {
      'Set-Cookie': `${STUDIO_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    });
  }
  // login
  const ip = clientIp(req);
  const wait = loginWaitMs(ip);
  if (wait > 0) {
    // Deliberately the same status and body as a wrong password: telling an
    // attacker which of the two happened tells them their guesses are landing.
    return sendStudioJson(res, { error: 'unauthorized' }, 401, {
      'Retry-After': String(Math.ceil(wait / 1000)),
    });
  }
  let password = '';
  try {
    const parsed = JSON.parse(await readBody(req));
    password = (parsed && typeof parsed.password === 'string') ? parsed.password : '';
  } catch (e) {
    password = '';
  }
  if (!password || !secretEquals(password, STUDIO_PASSWORD)) {
    noteLoginFail(ip);
    return sendStudioJson(res, { error: 'unauthorized' }, 401);
  }
  loginFails.delete(ip);
  // Secure would make the cookie unsettable over plain http://localhost in some
  // browsers, so it follows the actual scheme rather than being hardcoded.
  const https = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    || process.env.NODE_ENV === 'production';
  const maxAge = STUDIO_SESSION_HOURS * 3600;
  return sendStudioJson(res, { ok: true }, 200, {
    'Set-Cookie': `${STUDIO_COOKIE}=${studioIssue()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
      + (https ? '; Secure' : ''),
  });
}

/**
 * Everything the stats dashboard draws, computed from what is already in memory.
 * ~600 feed items, so this is microseconds and needs no cache of its own.
 *
 * One honesty note that shaped the shape of this payload. `programs` is keyed by
 * normalised **title**; `feeds` and `showinfo` are keyed by archive **slug**.
 * They are different key spaces — intersecting them directly yields 3, by
 * coincidence. So "149 programs → 122 feeds → 115 records" is NOT a funnel: it
 * is three counts of three different things, and drawing it as one would imply a
 * containment that does not exist. Coverage is therefore reported as separate
 * ratios, each against its own denominator, and the directory match is done by
 * normalised title with its imprecision stated rather than hidden.
 */
const DURATION_BUCKETS = [
  { label: 'under 30m', max: 1800 },
  { label: '30–60m', max: 3600 },
  { label: '60–90m', max: 5400 },
  { label: '90–120m', max: 7200 },
  { label: 'over 2h', max: Infinity },
];

function studioStats() {
  const entries = Object.entries(feedStore);
  const catMap = new Map();
  const dayMap = new Map();
  const durations = DURATION_BUCKETS.map((b) => ({ label: b.label, episodes: 0 }));
  const shows = [];
  let episodes = 0, seconds = 0, bytes = 0, unknownDuration = 0;
  let oldest = Infinity, newest = 0;

  for (const [slug, rec] of entries) {
    const items = (rec && rec.items) || [];
    let showSeconds = 0, showBytes = 0, showNewest = 0;
    for (const it of items) {
      episodes++;
      const d = it.durationSec || 0;
      seconds += d; showSeconds += d;
      bytes += it.bytes || 0; showBytes += it.bytes || 0;
      if (it.dt) {
        if (it.dt < oldest) oldest = it.dt;
        if (it.dt > newest) newest = it.dt;
        if (it.dt > showNewest) showNewest = it.dt;
        const day = new Date(it.dt * 1000).toISOString().slice(0, 10);
        dayMap.set(day, (dayMap.get(day) || 0) + 1);
      }
      const cat = it.category || 'Uncategorised';
      const c = catMap.get(cat) || { episodes: 0, seconds: 0 };
      c.episodes++; c.seconds += d;
      catMap.set(cat, c);
      // A missing duration is counted as unknown rather than silently dropped
      // into the smallest bucket, which would invent short episodes.
      if (d > 0) {
        for (let i = 0; i < DURATION_BUCKETS.length; i++) {
          if (d < DURATION_BUCKETS[i].max) { durations[i].episodes++; break; }
        }
      } else unknownDuration++;
    }
    shows.push({
      slug,
      title: (rec && rec.channel && rec.channel.title) || slug,
      episodes: items.length,
      seconds: showSeconds,
      bytes: showBytes,
      newest: showNewest,
      fetchedAt: (rec && rec.fetchedAt) || 0,
    });
  }

  // Every day across the window, including the empty ones — a gap in the
  // schedule is exactly the thing this chart exists to make visible, and a
  // sparse series would quietly close it up.
  const perDay = [];
  if (newest && oldest !== Infinity) {
    const DAY = 86400000;
    const start = Date.UTC(...new Date(oldest * 1000).toISOString().slice(0, 10).split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));
    const end = Date.UTC(...new Date(newest * 1000).toISOString().slice(0, 10).split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));
    for (let t = start; t <= end; t += DAY) {
      const day = new Date(t).toISOString().slice(0, 10);
      perDay.push({ day, episodes: dayMap.get(day) || 0 });
    }
  }

  const programs = programCache.programs || {};
  const programKeys = new Set(Object.keys(programs));
  const noDescription = [];
  const noDirectory = [];
  for (const [slug, rec] of entries) {
    if (!showInfo[slug]) noDescription.push(slug);
    if (!programKeys.has(normTitle(rec && rec.channel && rec.channel.title))) noDirectory.push(slug);
  }

  return {
    generated: Date.now(),
    window: {
      oldest: oldest === Infinity ? 0 : oldest,
      newest,
      days: perDay.length,
    },
    totals: {
      feeds: entries.length,
      episodes,
      hours: Math.round(seconds / 3600),
      bytes,
      categories: catMap.size,
      programs: programKeys.size,
      showinfo: Object.keys(showInfo).length,
      unknownDuration,
    },
    /**
     * The THIN end, not the top.
     *
     * A "top shows by hours" chart was built first and was worthless: upstream
     * caps every feed at 5 episodes, 83 of 122 shows sit at that cap, and the
     * top twelve are a twelve-way tie at 10.01h — twelve identical bars. The
     * informative end is the other one. A show with a single episode in the
     * window either just launched, airs rarely, or has a feed that has stopped
     * publishing, and that last case is worth someone looking at.
     */
    thinnest: shows.slice()
      .filter((s) => s.episodes > 0)
      .sort((a, b) => a.seconds - b.seconds)
      .slice(0, 12),
    // How many shows hold how many episodes. Says in one glance what the tie
    // above says the long way round.
    episodeSpread: [...shows.reduce((m, s) => m.set(s.episodes, (m.get(s.episodes) || 0) + 1), new Map())]
      .map(([episodes, count]) => ({ episodes, count }))
      .sort((a, b) => b.episodes - a.episodes),
    categories: [...catMap.entries()]
      .map(([name, v]) => ({ name, episodes: v.episodes, hours: Math.round(v.seconds / 3600) }))
      .sort((a, b) => b.episodes - a.episodes),
    perDay,
    durations,
    coverage: {
      feeds: entries.length,
      withDescription: entries.length - noDescription.length,
      withDirectory: entries.length - noDirectory.length,
      directoryPrograms: programKeys.size,
      // Named, not just counted — a number nobody can act on is decoration.
      noDescription: noDescription.slice(0, 60),
      noDirectory: noDirectory.slice(0, 60),
    },
    shows: shows.sort((a, b) => a.title.localeCompare(b.title)),
  };
}

function studioApi(req, res, pathOnly) {
  if (!studioAuthed(req)) return sendStudioJson(res, { error: 'unauthorized' }, 401);
  if (pathOnly === '/api/studio/usage') {
    return sendStudioJson(res, usageReport(30));
  }
  if (pathOnly === '/api/studio/stats') {
    refreshProgramsIfStale();
    return sendStudioJson(res, studioStats());
  }
  if (pathOnly === '/api/studio/health') {
    return sendStudioJson(res, {
      station: STATION_ID,
      version: appVersion(),
      studioVersion: studioVersion(),
      node: process.version,
      startedAt: storageDiag.bootedAt,
      uptimeSec: Math.round(process.uptime()),
      storage: storageReport(),
      feeds: {
        held: Object.keys(feedStore).length,
        lastHarvest: feedsDiag.lastHarvest,
        notModified: feedsDiag.notModified,
        failed: feedsDiag.failed,
        // The one with a denominator — see feedsDiag's header.
        lastSweep: feedsDiag.lastSweep,
        failures: feedsDiag.failures,
        // Feeds we have not confirmed current within a whole TTL. `fetchedAt`
        // now moves on a 304, so this means "not checked", not "not changed".
        stale: Object.entries(feedStore)
          .filter(([, r]) => !r || !r.fetchedAt || Date.now() - r.fetchedAt > FEEDS_TTL)
          .map(([slug, r]) => ({ slug, fetchedAt: (r && r.fetchedAt) || 0 }))
          .sort((a, b) => a.fetchedAt - b.fetchedAt)
          .slice(0, 30),
        nextSweepInMs: Math.max(0, FEEDS_TTL - (Date.now() - feedsHarvestedAt)),
      },
      // Every upstream host we actually talked to, timed from real traffic.
      upstream: [...upstreamDiag.entries()]
        .map(([host, d]) => Object.assign({ host }, d))
        .sort((a, b) => b.lastAt - a.lastAt),
      process: {
        uptimeSec: Math.round(process.uptime()),
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
        heapMb: Math.round(process.memoryUsage().heapUsed / 1048576),
        node: process.version,
        caches: {
          archive: archiveCache.stats(),
          nowplaying: nowCache.stats(),
        },
      },
      counts: {
        showinfo: Object.keys(showInfo).length,
        programs: Object.keys(programCache.programs || {}).length,
        feeds: Object.keys(feedStore).length,
      },
    });
  }
  return sendStudioJson(res, { error: 'not found' }, 404);
}

// --------------------------------------------------------------- the server

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  const pathOnly = url.split('?')[0];

  // The blanket GET/HEAD rule stays; POST is opened for the studio's two auth
  // routes and nothing else. A global `if (method === 'POST')` would be a much
  // larger change than this feature needs.
  if (req.method === 'POST') {
    // The one public POST: a fire-and-forget usage beacon. No auth by design —
    // it carries no identity and answers 204 to everything.
    if (USAGE_TRACKING && pathOnly === '/api/ev') {
      try { return await ingestEvent(req, res); }
      catch (e) { res.writeHead(204, securityHeaders()); return res.end(); }
    }
    if (STUDIO_ENABLED && (pathOnly === '/api/studio/login' || pathOnly === '/api/studio/logout')) {
      try {
        return await studioPost(req, res, pathOnly);
      } catch (e) {
        return sendStudioJson(res, { error: 'bad request' }, 400);
      }
    }
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    return res.end('method not allowed');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    return res.end('method not allowed');
  }

  // Registered before serveStatic, which would otherwise answer /studio with
  // the listener app (notFound() falls back to index.html for any path without
  // an extension). When the studio is disabled these ifs are skipped entirely
  // and that fallback is exactly what we want to happen.
  if (STUDIO_ENABLED && (pathOnly === '/studio' || pathOnly === '/studio/')) {
    return sendStudioHtml(req, res, studioAuthed(req) ? 'studio.html' : 'login.html');
  }
  if (STUDIO_ENABLED && pathOnly.startsWith('/api/studio/')) {
    return studioApi(req, res, pathOnly);
  }

  try {
    if (url === '/api/archive') {
      const data = await getArchive();
      return sendJson(res, data, 200, 300);
    }
    // Freshness probe: the same cached scrape as /api/archive minus the ~185 KB
    // of rows, so an open tab can poll for new episodes cheaply and only pull the
    // full listing when the user asks for it.
    if (url === '/api/archive/head') {
      const data = await getArchive();
      return sendJson(res, {
        updated: data.updated,
        count: data.count,
        latest: data.latest,
      }, 200, 60);
    }
    if (url === '/api/nowplaying') {
      const data = await getNowPlaying();
      return sendJson(res, data, 200, 10);
    }
    // Single-show lookup, resolved on demand from archive2's per-show endpoint.
    // The bulk /api/showinfo below stays the front end's first paint; this fills
    // the gaps for shows the on-air harvest has never met.
    if (url.startsWith('/api/showinfo/')) {
      const altid = decodeURIComponent(url.slice('/api/showinfo/'.length).split('?')[0]);
      // altids upstream are bare word characters; refuse anything else rather
      // than forward it into a POST body
      if (!/^[A-Za-z0-9_]{1,64}$/.test(altid)) {
        return sendJson(res, { error: 'bad altid' }, 400);
      }
      const info = await getShowDetail(altid);
      return sendJson(res, { altid, info: info || null }, 200, info ? 3600 : 300);
    }
    if (url === '/api/showinfo') {
      // harvested lazily by the now-playing poll; empty until the first one lands
      await getNowPlaying().catch(() => {});
      return sendJson(res, {
        updated: showInfoUpdated,
        count: Object.keys(showInfo).length,
        shows: showInfo,
      }, 200, 60);
    }
    if (url === '/api/programs') {
      refreshProgramsIfStale();
      return sendJson(res, {
        updated: programCache.updated || 0,
        count: Object.keys(programCache.programs || {}).length,
        programs: programCache.programs || {},
      }, 200, 600);
    }
    // Asked by the live player only after a play attempt fails, so the modal's
    // alert can name the actual cause instead of guessing.
    if (url === '/api/livestatus') {
      return sendJson(res, await probeLiveStream(), 200, 5);
    }
    if (url === '/healthz') {
      return sendJson(res, {
        ok: true,
        version: appVersion(),
        // Separate from `version` so a studio-only deploy is still verifiable.
        // Deliberately NOT reporting whether the studio is enabled: /healthz is
        // public, and there is no reason to hand a scanner the path. Whether it
        // is on is answered by visiting /studio, which is the same check but
        // requires already knowing where to look.
        studioVersion: studioVersion(),
        station: STATION_ID,
        // Answers "is persistent storage actually working?" from outside, which
        // is the only place it can be answered — see identifyVolume() and
        // probeMount(). `mounted` is readable on the FIRST deploy: false = no
        // volume at all, and a 64-hex `volume` = an anonymous one a redeploy
        // will replace. `instanceId` unchanged across two deploys is the proof.
        storage: storageReport(),
        // The app now publishes only what the feeds carry, so "how many feeds do
        // we hold" is the difference between a full archive and an empty one.
        // `held` at 0 with `lastHarvest` set means every fetch failed — the one
        // state that empties the site, and it is invisible from the outside
        // otherwise.
        feeds: {
          held: Object.keys(feedStore).length,
          lastHarvest: feedsDiag.lastHarvest,
          notModified: feedsDiag.notModified,
          failed: feedsDiag.failed,
        },
      });
    }
    if (url.startsWith('/pix/')) {
      return proxyPix(url.slice('/pix/'.length).split('?')[0], res);
    }
    // A `?show=` link is usually first fetched by a link-preview crawler, which
    // reads the OG tags once and caches the card. If the archive cache is cold
    // (fresh boot / fresh deploy) that one shot would get the generic station
    // image forever, so warm it first. Failures fall through to the defaults.
    if (url.includes('?') && new URLSearchParams(url.slice(url.indexOf('?') + 1)).has('show')) {
      await getArchive().catch(() => {});
    }
    return serveStatic(req, url, res);
  } catch (err) {
    // graceful degradation: serve last-good cached data if we have it
    if (url === '/api/archive' && archiveCache.stale()) {
      return sendJson(res, archiveCache.stale(), 200, 60);
    }
    if (url === '/api/archive/head' && archiveCache.stale()) {
      const s = archiveCache.stale();
      return sendJson(res, { updated: s.updated, count: s.count, latest: s.latest }, 200, 60);
    }
    if (url === '/api/nowplaying' && nowCache.stale()) {
      return sendJson(res, nowCache.stale(), 200, 10);
    }
    console.error(`[error] ${url}:`, err.message);
    return sendJson(res, { error: 'upstream unavailable' }, 502);
  }
});

// Only listen when run as a program. `require()`ing this file — which the
// storage tests do, to reach probeMount without a Linux box — must not bind a
// port or start the background harvests hanging off the listen callback.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`WBAI Archive server listening on :${PORT}`);
    refreshProgramsIfStale();
  });
}

module.exports = { probeMount };
