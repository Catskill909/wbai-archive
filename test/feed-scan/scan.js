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
 *   node scan.js --any-change exit 1 on routine churn too
 *
 * Exit status:  0 = nothing notable   1 = something notable changed   2 = scan failed
 * So it is cron-able: non-zero means "a human should look."
 *
 * "Notable" is doing real work there. Sixty shows advance their newest pubDate
 * in an ordinary week, so exiting 1 on *any* difference means a daily failure
 * mail forever, and a daily failure mail is a mail nobody opens on the day the
 * feeds actually die. Only NOTABLE kinds set the exit status; the rest are
 * printed and then kept quiet about.
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

/**
 * The kinds that mean a human should look now.
 *
 * Everything else is the archive working: new episodes arriving, item counts
 * moving as the cap slides, a new show appearing in the listing before its feed
 * exists. Those are reported — they are the evidence the scanner can still see —
 * but they do not raise an alarm. CLAIM_RESOLVED is deliberately routine: it is
 * an alarm switching *off*, which needs no one's attention.
 *
 * FEED_APPEARED was notable until 2026-08-05, as "the migration signal". That
 * rationale expired on 2026-07-29, when the app became feed-only: a feed turning
 * on IS the migration now, not a warning about it. It fired on four of the eight
 * runs to that date — breakthrnewsradio on the 4th, explorafri on the 5th, each
 * a show reaching its first archived episode, with twenty more slugs still
 * waiting for theirs. Nobody has to do anything about one: getArchive discovers
 * the slug from the listing and the hourly harvest picks the feed up by itself.
 * The scanner already agreed, inconsistently — the same event for a slug it had
 * never seen before is NEW_FEED, which is routine. A daily failure mail is one
 * nobody opens on the day the feeds die; see the note above the exit status.
 */
const NOTABLE = new Set([
  'CAP_CHANGED',      // the cap moved; the migration arithmetic is stale
  'CLAIM_MISMATCH',   // the 2026-07-29 regression, caught while it is still a claim
  'FEED_DELISTED',    // a live feed no longer claimed — but see the threshold below
  'FEED_LOST',        // including 200-with-zero-bytes, the July failure mode
  'SLUG_GONE',        // a show we remember is no longer offered anywhere
]);

/**
 * FEED_DELISTED is notable by *count*, not by kind alone (added 2026-08-22).
 *
 * One show retiring is lineup turnover, and docs/missing-show.md already said
 * so: WBAI's scheduling records were corrected by hand after the late-July
 * cutover, and shows recorded under the old configuration keep aging out of
 * the current listing one at a time — each firing a single FEED_DELISTED. The
 * app handles every one of them by design (episodes stay as feed-only
 * history), so each mail was asking a human to confirm something no one had
 * to act on: demnoweve on 08-22 was at least the third such mail.
 *
 * Many delisting in the SAME scan is a different event — the signature of a
 * broken upstream listing or parser rather than a programming change, and the
 * doc's own line ("many disappearing at once still deserve investigation") is
 * the rule encoded here. Singles and pairs are still printed, under routine.
 */
const DELIST_ALARM_AT = 3;

// The one classification the exit status and the report both use. A kind in
// NOTABLE alarms as itself, except FEED_DELISTED, which alarms only in bulk.
function splitNotable(changes) {
  const delists = changes.filter((c) => c.kind === 'FEED_DELISTED').length;
  const isNotable = (c) =>
    NOTABLE.has(c.kind) && (c.kind !== 'FEED_DELISTED' || delists >= DELIST_ALARM_AT);
  return {
    notable: changes.filter(isNotable),
    routine: changes.filter((c) => !isNotable(c)),
  };
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const noSave = args.includes('--no-save');
const full = args.includes('--full');
const anyChange = args.includes('--any-change');

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

/**
 * slug -> does the listing render a podcast XML button on that show's rows?
 *
 * This is archive2's *claim* that a feed exists, which is a different thing from
 * a feed existing, and the two came apart on 2026-07-29: 21 shows — `manrat`,
 * `salsasho`, `kwave` and others, several of them music programmes that cannot
 * be podcast at all for copyright reasons — began rendering the button while
 * their `/xml/<slug>.xml` still answered 404. The server had been deciding what
 * to publish from that claim, so a fortnight of invented "A Mansion for the Rat"
 * rows walked back into the app.
 *
 * Tracking the claim next to the reality is what lets this scanner see that
 * class of drift at all. It is the whole reason CLAIM_MISMATCH exists.
 */
function claimsFromRows(html) {
  const starts = [...html.matchAll(/<tr name="show"[^>]*\ssho="([^"]*)"[^>]*>/g)];
  const claims = new Map();
  for (let i = 0; i < starts.length; i++) {
    const body = html.slice(
      starts[i].index,
      i + 1 < starts.length ? starts[i + 1].index : starts[i].index + 3000
    );
    // A show's rows should agree; if any one advertises a feed, treat it as claimed.
    if (!claims.get(starts[i][1])) claims.set(starts[i][1], /getrss\.php/.test(body));
  }
  return claims;
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
  // Conditional GET. Honoured upstream, but do not expect it to save anything on
  // a daily run: archive2 rebuilds every feed in one batch, so every stored
  // timestamp is older than the last rebuild and the answer is a full 200. It
  // pays off only on back-to-back runs, and costs one header otherwise. See the
  // Load section of README.md.
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

  // The listing advertises a feed that isn't there. This is what shipped a
  // regression on 2026-07-29 and it is the highest-value signal here: it fires
  // while upstream is still only *claiming*, before anything downstream that
  // trusts the claim can act on it.
  const mismatch = (r) => !!r.claimed && !live(r);
  // The mirror case: a working feed on a show the listing does not advertise.
  // Confirmed 2026-08-04 (`heavywaits` — gone from the dropdown, rows AND
  // schedule, feed still live). The server now discovers and slow-probes these
  // (catchUpFeeds's unclaimed pass, b46c690 + the knownSlugs memory added
  // alongside this fix) and synthesizes display rows straight from the feed
  // when no listing row exists (applyFeeds's `feedOnlySlugs`), so this is no
  // longer silent content loss — but it is still worth a human's attention:
  // it records either a removed XML claim or a show leaving the current lineup.
  const delisted = (r) => !r.claimed && live(r);

  for (const [slug, r] of Object.entries(now.feeds)) {
    const p = prev[slug];

    if (!p) {
      changes.push(live(r)
        ? { kind: 'NEW_FEED', slug, detail: `${r.items} items, newest ${r.newest}` }
        : { kind: 'NEW_SLUG', slug, detail: `no feed yet (HTTP ${r.status})` });
      // A brand-new slug can arrive already mismatched; say so rather than
      // waiting for a second run to notice.
      if (mismatch(r)) {
        changes.push({ kind: 'CLAIM_MISMATCH', slug, detail: `new slug already advertises a feed that 404s` });
      }
      continue;
    }

    // Claim-vs-reality transitions, reported on the edge so a standing
    // mismatch does not shout on every run.
    if (mismatch(r) && !mismatch(p)) {
      changes.push({
        kind: 'CLAIM_MISMATCH', slug,
        detail: `listing now advertises a podcast XML button but /xml/${slug}.xml is HTTP ${r.status}` +
          ' — anything gating on hasRSS will publish this show',
      });
    } else if (!mismatch(r) && mismatch(p)) {
      changes.push({ kind: 'CLAIM_RESOLVED', slug, detail: live(r) ? 'feed now exists' : 'listing stopped advertising it' });
    }
    if (delisted(r) && !delisted(p)) {
      const placement = r.listed === false
        ? (r.scheduled === true
          ? 'absent from the archive listing but still present on the current schedule'
          : 'absent from the current archive listing and schedule')
        : 'still listed, but no longer marked with an XML button';
      changes.push({
        kind: 'FEED_DELISTED', slug,
        detail: `${r.items} items in a live feed; ${placement} — the app keeps remembered episodes ` +
          'as feed-only history. This can be normal after a lineup update, but is worth noting as ' +
          'part of the schedule change.',
      });
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
module.exports = { diff, parseFeed, slugsFromDropdown, slugsFromRows, slugsFromSchedule, NOTABLE, splitNotable, DELIST_ALARM_AT };

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
  const claims = claimsFromRows(listing);
  const remembered = prevState ? Object.keys(prevState.feeds || {}) : [];

  if (!fromDropdown.length && !fromRows.length) {
    console.error('scan: parsed zero slugs from the listing — the page changed shape. Refusing to report.');
    process.exit(2);
  }

  const candidates = [...new Set([...fromDropdown, ...fromRows, ...fromSchedule, ...remembered])].sort();

  const results = await pool(candidates, CONCURRENCY, (slug) =>
    probe(slug, prevState && prevState.feeds ? prevState.feeds[slug] : null));

  const feeds = {};
  // The claim is recorded after probing, so a 304 (which carries the previous
  // record forward wholesale) still gets today's claim rather than yesterday's.
  const listed = new Set([...fromDropdown, ...fromRows]);
  const scheduled = new Set(fromSchedule);
  for (const r of results) {
    feeds[r.slug] = Object.assign({}, r, {
      claimed: claims.get(r.slug) === true,
      listed: listed.has(r.slug),
      scheduled: scheduled.has(r.slug),
    });
  }

  const liveFeeds = results.filter((r) => r.status === 200 && !r.empty && r.items > 0);
  const isLive = (r) => r.status === 200 && !r.empty && r.items > 0;
  const mismatched = Object.values(feeds).filter((r) => r.claimed && !isLive(r));
  const delisted = Object.values(feeds).filter((r) => !r.claimed && isLive(r));
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
    claimed: Object.values(feeds).filter((r) => r.claimed).length,
    mismatched: mismatched.length,
    delisted: delisted.length,
    maxItems: liveFeeds.reduce((m, r) => Math.max(m, r.items), 0),
    notModified: results.filter((r) => r.notModified).length,
    feeds,
  };

  const changes = diff(prevState, now);
  const { notable, routine } = splitNotable(changes);

  if (asJson) {
    console.log(JSON.stringify({ ...now, changes, notable, firstRun: !prevState }, null, 2));
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
    console.log(`  listing claims a feed: ${now.claimed}   ` +
      `claim without a feed: ${now.mismatched}   live feed not currently claimed: ${now.delisted}`);
    if (now.mismatched) {
      console.log('  ! ' + now.mismatched + ' show(s) advertise a podcast XML button with no feed behind it.');
      console.log('    Publishing off `hasRSS` would put them in the app. Gate on the fetch.');
    }

    const order = ['CAP_CHANGED', 'CLAIM_MISMATCH', 'FEED_DELISTED', 'FEED_LOST', 'FEED_APPEARED', 'SLUG_GONE', 'NEW_FEED', 'CLAIM_RESOLVED', 'NEW_SLUG', 'ITEM_COUNT', 'NEW_EPISODE'];
    const list = (cs) => {
      cs.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
        .forEach((c) => console.log(`    ${c.kind.padEnd(15)} ${c.slug.padEnd(24)} ${c.detail}`));
    };

    if (!prevState) {
      console.log('\n  first run — baseline written, nothing to diff against yet.');
    } else if (!changes.length) {
      console.log('\n  no changes since ' + prevState.scannedAt);
    } else {
      if (notable.length) {
        console.log(`\n  ${notable.length} NOTABLE change(s) since ${prevState.scannedAt}:`);
        list(notable);
      } else {
        console.log(`\n  nothing notable since ${prevState.scannedAt}.`);
      }
      // Printed even though it is quiet, because "the archive is still moving" is
      // the evidence that a silent scan is silent for the right reason.
      if (routine.length) {
        console.log(`\n  ${routine.length} routine change(s) — the archive working normally:`);
        list(routine);
      }
    }
  }

  if (!noSave) fs.writeFileSync(STATE_PATH, JSON.stringify(now, null, 1));

  process.exit(prevState && (anyChange ? changes.length : notable.length) ? 1 : 0);
})().catch((e) => {
  console.error('scan failed:', (e && e.stack) || e);
  process.exit(2);
});
