#!/usr/bin/env node
/**
 * Scans archive2 for per-show XML feeds and reports what CHANGED since last run.
 *
 * Why a scanner and not a one-off check: the feeds are not a published contract.
 * They died once (0 bytes, HTTP 200) and revived two days later without notice,
 * and the episodes-per-feed cap is a setting in WBAI's archiver that can move
 * under us. The useful question is never "what do the feeds look like" — it is
 * "what is different from the last time we looked."
 *
 * Read-only. Touches upstream and this directory's state file, nothing else.
 * Zero dependencies; global fetch (Node 18+).
 *
 *   node scan.js              scan, diff against state.json, print a report
 *   node scan.js --json       same, machine-readable on stdout
 *   node scan.js --no-save    do not update state.json (dry run)
 *   node scan.js --full       ignore stored Last-Modified, re-fetch every feed
 *
 * Exit status:  0 = nothing changed   1 = something changed   2 = scan failed
 * So it is cron-able: non-zero means "a human should look."
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LISTING = 'https://archive2.wbai.org/';
const SCHEDULE = 'https://confessor2.wbai.org/playlist/pub_sched.php';
const FEED = (slug) => `https://archive2.wbai.org/xml/${encodeURIComponent(slug)}.xml`;
const UA = 'wbai-archive/1.0 (+https://github.com/Catskill909/wbai-archive)';

const STATE_PATH = path.join(__dirname, 'state.json');
const CONCURRENCY = 5; // a small station's Apache. Do not raise this.

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const noSave = args.includes('--no-save');
const full = args.includes('--full');

// ------------------------------------------------------------------ plumbing

async function get(url, headers) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...(headers || {}) } });
  return res;
}

// The listing pages are ISO-8859-1; slugs are ASCII either way, but decoding as
// latin1 keeps show titles from turning into replacement characters.
async function getLatin1(url) {
  const res = await get(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('latin1');
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

// ------------------------------------------------------------------ discovery

/**
 * The slug universe we probe. Three sources, deliberately overlapping, because
 * each one goes blind in a different way:
 *
 *  1. The <select id="sh_altid"> dropdown on the listing page — archive2's own
 *     show registry, and a far more stable parse than the <tr> attribute-order
 *     regex `parseArchive()` depends on.
 *  2. The <tr name="show"> rows — same set today, kept as a cross-check so a
 *     silent change to either parse shows up as a disagreement rather than as
 *     a quietly shorter list.
 *  3. pub_sched.php artwork preloads — catches a show that has been scheduled
 *     but has not been archived yet. Measured 2026-07-28: this found exactly
 *     one slug the other two did not (`breakthrnewsradio`).
 *
 * Plus every slug we have ever seen, from state.json, so a show dropping off
 * the listing never silently drops out of the scan.
 */
function slugsFromDropdown(html) {
  const sel = html.match(/<select[^>]*sh_altid[\s\S]*?<\/select>/i);
  if (!sel) return [];
  return [...sel[0].matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1]);
}

function slugsFromRows(html) {
  return [...html.matchAll(/<tr name="show"[^>]*\ssho="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
}

function slugsFromSchedule(html) {
  return [...html.matchAll(/pix\/([a-z0-9_]+)_med_\d+\.jpg/gi)].map((m) => m[1]);
}

// ------------------------------------------------------------------ feed read

function parseFeed(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const pubs = items
    .map((it) => (it.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1])
    .map((p) => (p ? Date.parse(p) : NaN))
    .filter((n) => !Number.isNaN(n));
  return {
    items: items.length,
    newest: pubs.length ? new Date(Math.max(...pubs)).toISOString() : null,
    buildDate: (xml.match(/<lastBuildDate>(.*?)<\/lastBuildDate>/) || [])[1] || null,
  };
}

async function probe(slug, prev) {
  const headers = {};
  // Conditional GET: the feeds answer 304 with an empty body, which makes a full
  // sweep almost free after the first one. No ETag and no gzip upstream, so
  // If-Modified-Since is the whole optimisation.
  if (!full && prev && prev.lastModified && prev.status === 200) {
    headers['If-Modified-Since'] = prev.lastModified;
  }

  let res;
  try {
    res = await get(FEED(slug), headers);
  } catch (e) {
    return { slug, status: 0, error: String((e && e.message) || e) };
  }

  if (res.status === 304) {
    return { ...prev, slug, status: 200, notModified: true };
  }
  if (res.status !== 200) {
    return { slug, status: res.status };
  }

  const xml = await res.text();
  // The failure mode that looks like success: HTTP 200 with nothing in it. This
  // is exactly how the feeds died in July, and why "status === 200" is never on
  // its own enough to call a feed healthy.
  if (!xml.trim().length) {
    return { slug, status: 200, bytes: 0, items: 0, empty: true };
  }

  return {
    slug,
    status: 200,
    bytes: xml.length,
    lastModified: res.headers.get('last-modified') || null,
    ...parseFeed(xml),
  };
}

// ------------------------------------------------------------------ diffing

function diff(prevState, now) {
  const prev = (prevState && prevState.feeds) || {};
  const changes = [];
  const live = (r) => r.status === 200 && !r.empty && r.items > 0;

  for (const [slug, r] of Object.entries(now.feeds)) {
    const p = prev[slug];

    if (!p) {
      changes.push(live(r)
        ? { kind: 'NEW_FEED', slug, detail: `${r.items} items, newest ${r.newest}` }
        : { kind: 'NEW_SLUG', slug, detail: `no feed yet (HTTP ${r.status})` });
      continue;
    }

    if (!live(p) && live(r)) {
      changes.push({ kind: 'FEED_APPEARED', slug, detail: `HTTP ${p.status} -> ${r.items} items` });
    } else if (live(p) && !live(r)) {
      changes.push({
        kind: 'FEED_LOST', slug,
        detail: r.empty ? 'HTTP 200 but ZERO BYTES (the July failure mode)'
          : r.status === 200 ? 'HTTP 200 but no <item>s'
            : `HTTP ${r.status}`,
      });
    } else if (live(p) && live(r)) {
      if (r.items !== p.items) {
        changes.push({ kind: 'ITEM_COUNT', slug, detail: `${p.items} -> ${r.items} items` });
      }
      if (r.newest && p.newest && r.newest !== p.newest) {
        changes.push({ kind: 'NEW_EPISODE', slug, detail: `newest ${p.newest} -> ${r.newest}` });
      }
    }
  }

  for (const slug of Object.keys(prev)) {
    if (!now.feeds[slug]) changes.push({ kind: 'SLUG_GONE', slug, detail: 'no longer offered anywhere' });
  }

  // The cap is a setting in WBAI's archiver and they can raise it. If it moves,
  // the coverage arithmetic in docs/xml-feed-migration.md is stale and the
  // "feeds cannot replace the scrape" conclusion needs re-deriving.
  //
  // Guarded on both sides having live feeds, because `maxItems` is a max across
  // all of them: when feeds go dark it collapses toward zero, and reporting that
  // as "the cap changed" would dress an outage up as a config change. The
  // outage already reports itself, once per feed, as FEED_LOST.
  const liveCount = (s) => Object.values((s && s.feeds) || {}).filter(live).length;
  if (prevState && typeof prevState.maxItems === 'number' && now.maxItems !== prevState.maxItems
      && liveCount(now) > 0 && liveCount(prevState) > 0) {
    changes.push({
      kind: 'CAP_CHANGED',
      slug: '*',
      detail: `max items per feed ${prevState.maxItems} -> ${now.maxItems}` +
        ' — re-run the coverage sweep, docs/xml-feed-migration.md is now out of date',
    });
  }

  return changes;
}

// ------------------------------------------------------------------ main

// `diff` is the only part with real logic and the only part that can rot into
// always-saying-"no changes". selftest.js drives it offline; see §3a of
// CLAUDE.md on why an assertion of absence has to prove it can still see the
// thing it claims is absent.
module.exports = { diff, parseFeed, slugsFromDropdown, slugsFromRows, slugsFromSchedule };

if (require.main !== module) return;

(async () => {
  const prevState = fs.existsSync(STATE_PATH)
    ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
    : null;

  const [listing, schedule] = await Promise.all([
    getLatin1(LISTING),
    getLatin1(SCHEDULE).catch(() => ''),
  ]);

  const fromDropdown = slugsFromDropdown(listing);
  const fromRows = slugsFromRows(listing);
  const fromSchedule = slugsFromSchedule(schedule);
  const remembered = prevState ? Object.keys(prevState.feeds || {}) : [];

  if (!fromDropdown.length && !fromRows.length) {
    console.error('scan: parsed zero slugs from the listing — the page changed shape. Refusing to report.');
    process.exit(2);
  }

  const candidates = [...new Set([...fromDropdown, ...fromRows, ...fromSchedule, ...remembered])].sort();

  const results = await pool(candidates, CONCURRENCY, (slug) =>
    probe(slug, prevState && prevState.feeds ? prevState.feeds[slug] : null));

  const feeds = {};
  for (const r of results) feeds[r.slug] = r;

  const liveFeeds = results.filter((r) => r.status === 200 && !r.empty && r.items > 0);
  const now = {
    scannedAt: new Date().toISOString(),
    sources: {
      dropdown: new Set(fromDropdown).size,
      rows: new Set(fromRows).size,
      schedule: new Set(fromSchedule).size,
      remembered: remembered.length,
      candidates: candidates.length,
    },
    withFeed: liveFeeds.length,
    withoutFeed: results.length - liveFeeds.length,
    maxItems: liveFeeds.reduce((m, r) => Math.max(m, r.items), 0),
    notModified: results.filter((r) => r.notModified).length,
    feeds,
  };

  const changes = diff(prevState, now);

  if (asJson) {
    console.log(JSON.stringify({ ...now, changes, firstRun: !prevState }, null, 2));
  } else {
    console.log(`scan ${now.scannedAt}`);
    console.log(`  slug sources: dropdown ${now.sources.dropdown}, rows ${now.sources.rows}, ` +
      `schedule ${now.sources.schedule}, remembered ${now.sources.remembered} ` +
      `-> ${now.sources.candidates} candidates`);
    if (new Set(fromDropdown).size !== new Set(fromRows).size) {
      console.log('  ! dropdown and rows disagree on the slug set — one of the two parses is drifting');
    }
    console.log(`  feeds live: ${now.withFeed}   no feed: ${now.withoutFeed}   ` +
      `max items/feed: ${now.maxItems}   304s: ${now.notModified}`);

    if (!prevState) {
      console.log('\n  first run — baseline written, nothing to diff against yet.');
    } else if (!changes.length) {
      console.log('\n  no changes since ' + prevState.scannedAt);
    } else {
      console.log(`\n  ${changes.length} change(s) since ${prevState.scannedAt}:`);
      const order = ['CAP_CHANGED', 'FEED_LOST', 'NEW_FEED', 'FEED_APPEARED', 'NEW_SLUG', 'SLUG_GONE', 'ITEM_COUNT', 'NEW_EPISODE'];
      changes.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
      for (const c of changes) console.log(`    ${c.kind.padEnd(15)} ${c.slug.padEnd(24)} ${c.detail}`);
    }
  }

  if (!noSave) fs.writeFileSync(STATE_PATH, JSON.stringify(now, null, 1));

  process.exit(prevState && changes.length ? 1 : 0);
})().catch((e) => {
  console.error('scan failed:', (e && e.stack) || e);
  process.exit(2);
});
