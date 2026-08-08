#!/usr/bin/env node
'use strict';

/**
 * schedule-audit — reconcile what WBAI says it airs against what the app can
 * actually play, and remember the answer so next week's run is a diff.
 *
 * Written 2026-08-08 out of the "From The Soundboard" hunt (docs/missing-show.md):
 * a show aired every Tuesday at midnight, was recorded, sat on archive2 with a
 * working MP3 — and never reached the app, because every one of its recordings
 * was flagged Private in confessor and so no podcast feed was ever written. That
 * took an afternoon of hand-rolled curl to find. It is four checks, and this is
 * them.
 *
 *   node tools/schedule-audit.js [--probe] [--strict] [--json] [--no-save]
 *
 *   --probe    also fetch the feed for each anomalous slug (a few requests,
 *              capped) to prove the feed is really missing rather than inferred.
 *              On by default; --no-probe to skip.
 *   --strict   exit 1 if there are any NEW findings since the last run. For a
 *              cron or a CI step that should shout only when something changed.
 *   --json     emit the raw report instead of the human summary.
 *   --no-save  don't update the snapshot (a dry run that can't affect the diff).
 *
 * Env: APP=http://localhost:8080   the running app to audit against
 *      STATE=data/schedule-audit.json   where the week-over-week snapshot lives
 *
 * WHAT IT CANNOT SEE. confessor2.wbai.org is password-gated, so nothing here
 * reads the Podcast / Private / "# In Podcast" checkboxes that ultimately decide
 * whether a feed gets written. This tool's job is to point at the exact show and
 * say "go look at these fields" — the last step is a human with a login. Where it
 * can infer the cause from the public listing (a `private="1"` row), it says so.
 *
 * BE SPARING WITH UPSTREAM. Two page fetches and one local API call by default.
 * Comparing slug *sets* answers "what is missing" in one request; probing all 127
 * feeds to find out would be 127 requests at a small station's server, every run.
 */

const fs = require('fs');
const path = require('path');

const APP = process.env.APP || 'http://localhost:8080';
const STATE = process.env.STATE || path.join('data', 'schedule-audit.json');

/**
 * THE CONFIG CUTOVER — the single most misleading thing about this data.
 *
 * WBAI's own scheduling tools were misconfigured until late July 2026: wrong
 * shows, wrong and new timeslots, wrong artwork. The records were then fixed by
 * hand, show by show, so the change is a smear rather than an instant.
 *
 * Archive2 retains ~115 days of rows and data/feeds.json accumulates for ever,
 * which means MOST of what either source holds describes the OLD, broken setup.
 * Reading it as the station's current intent produces confident wrong answers —
 * "this slot has been empty for months" when the slot did not exist until two
 * weeks ago. So everything older than this date is labelled `old config` and is
 * never on its own grounds for a finding.
 *
 * The default is inferred, not confirmed: the Wednesday 3am rebroadcast recorded
 * under `soundreb` on 2026-07-29 and under `ftsb` on 2026-08-05, and `ftsb` has
 * no Tuesday 2026-07-28 recording though retention would still show one. Set
 * CUTOVER=YYYY-MM-DD once the real date is known.
 */
const CUTOVER = process.env.CUTOVER || '2026-07-26';
const CUTOVER_TS = Math.floor(new Date(CUTOVER + 'T00:00:00Z').getTime() / 1000);
const ARCHIVE2 = 'https://archive2.wbai.org/';
const WBAI_SCHED = 'https://wbai.org/schedule/';
const UA = 'wbai-archive schedule-audit (+https://github.com/Catskill909/wbai-archive)';

const argv = process.argv.slice(2);
const OPT = {
  probe: !argv.includes('--no-probe'),
  strict: argv.includes('--strict'),
  json: argv.includes('--json'),
  save: !argv.includes('--no-save'),
};
const PROBE_CAP = 12;          // an anomaly list longer than this is a broken scrape, not 12 real bugs

// ---------------------------------------------------------------- fetching

async function getText(url, ms = 30000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function head(url, ms = 25000) {
  // GET, not HEAD: getrss.php answers 200 to both, but only a GET reveals that
  // the body is empty — which is the whole tell for a feed that does not exist.
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(ms),
    });
    const body = await res.text();
    return { status: res.status, bytes: body.length, type: res.headers.get('content-type') || '', items: (body.match(/<item[\s>]/g) || []).length };
  } catch (e) {
    return { status: 0, bytes: 0, type: '', items: 0, error: String(e.message || e) };
  }
}

// ------------------------------------------------------------- archive2

/**
 * Rows off archive2's listing.
 *
 * SPLIT ON ROW BOUNDARIES, never `<tr name="show"[^>]*>(.*?)</tr>`. Every row
 * embeds its own nested table, so a non-greedy match stops at the *inner*
 * `</tr>` and truncates the body before the play button — which is exactly how
 * the first pass of the Soundboard audit reported "0 private rows" while
 * `private="1"` sat in the document three times. (CLAUDE.md §3a: the
 * measurement was clean and wrong.)
 */
function parseArchive2(html) {
  const starts = [];
  const re = /<tr name="show"/g;
  let m;
  while ((m = re.exec(html))) starts.push(m.index);
  starts.push(html.length);

  const rows = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const seg = html.slice(starts[i], starts[i + 1]);
    const sho = /sho="([^"]+)"/.exec(seg);
    if (!sho) continue;
    const date = /([A-Z][a-z]+day, [A-Z][a-z]+ \d+, \d{4} [\d:]+ ?[ap]m)/.exec(seg);
    rows.push({
      sho: sho[1],
      title: (/class="showtitle"[^>]*>([^<]+)/.exec(seg) || [, ''])[1].trim(),
      dt: Number((/dt="(\d+)"/.exec(seg) || [, 0])[1]),
      dateText: date ? date[1] : '',
      length: (/showlen>([^<]+)/.exec(seg) || [, ''])[1].trim(),
      daysLeft: Number((/daystostay">\s*(\d+)/.exec(seg) || [, -1])[1]),
      // The two flags that decide whether this recording can ever become a feed
      // item. `private` is rendered per RECORDING, which is why unticking the
      // box in confessor does not rescue episodes already on disk.
      private: /private="1"/.test(seg),
      hasRSS: seg.includes('getrss.php'),
      mp3: (/mp3="([^"]+\.mp3)"/.exec(seg) || [, ''])[1],
    });
  }
  return rows;
}

// --------------------------------------------------------- wbai.org grid

/**
 * wbai.org/schedule/ embeds its week as a JS array of {title, start, end}.
 * This is the station's CLAIM about what airs — the only source that knows about
 * a slot whose show has never been recorded at all, which archive2 cannot tell
 * you by construction.
 */
function parseWbaiGrid(html) {
  const out = [];
  const re = /title\s*:\s*["'](.*?)["']\s*,\s*start\s*:\s*["'](.*?)["']/gs;
  let m;
  while ((m = re.exec(html))) {
    const t = /(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(m[2]);
    if (!t) continue;
    const [, y, mo, d, hh, mi] = t.map(Number);
    const day = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    out.push({ title: m[1].trim(), day, hh, mi, start: m[2] });
  }
  return out;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (h, m) => String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');

/**
 * Weekly slots, de-duplicated across the several weeks the page carries. A slot
 * is (weekday, time, title) — the unit a listener would call "the Tuesday
 * midnight show".
 */
function weeklySlots(events) {
  const by = new Map();
  for (const e of events) {
    const key = `${e.day}|${hhmm(e.hh, e.mi)}|${e.title}`;
    const rec = by.get(key) || { day: e.day, time: hhmm(e.hh, e.mi), title: e.title, weeks: 0 };
    rec.weeks++;
    by.set(key, rec);
  }
  return [...by.values()].sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
}

// ------------------------------------------------------------- matching

// Titles are spelled differently in all three systems ("Haitian All-Starz" vs
// "All-StarZ", "Early Morning Tuesdays - Good Morning Nueva York"). Normalise
// hard, then match on containment either way. Anything left over is reported as
// UNMATCHED rather than MISSING — a fuzzy miss is not evidence of a gap, and a
// tool that cries wolf weekly gets ignored, which is the failure mode that
// matters most for something meant to run forever.
const FILLER = new Set(['the', 'a', 'an', 'with', 'and', 'show', 'radio', 'wbai', 'live', 'hour']);
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function keyset(s) {
  return new Set(norm(s).split(' ').filter((w) => w && !FILLER.has(w)));
}
// Character-bigram Dice, the same instrument programFor() uses in server.js. It
// is the tier that survives a MISSPELLING, which word-set matching cannot:
// archive2 files the Sunday 2pm show as "The Ablitionist Show" while wbai.org's
// grid calls it "The Abolitionist Show", and those share no rare whole word.
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const [g, v] of B) { nb += v; if (A.has(g)) inter += Math.min(v, A.get(g)); }
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

// Longest common prefix, trimmed back to a word boundary so "radio gbe n" does
// not count as agreement on a word neither title finished spelling.
function prefixWords(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const cut = a.slice(0, i);
  const trimmed = (i < a.length && a[i] !== ' ') ? cut.slice(0, cut.lastIndexOf(' ') + 1) : cut;
  return trimmed.trim();
}

/**
 * Tiered, loosest last. Each tier exists because a real pair of titles defeated
 * the one above it — the four listed here all fired as false "missing show"
 * reports on the first run (2026-08-08) and every one of them was a spelling
 * difference for a show the app already had. A weekly tool that cries wolf gets
 * ignored, so an unmatched title is reported as UNMATCHED, never as MISSING.
 */
function looksLike(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  // 1. exact, or one title is the other plus a qualifier
  //    ("Democracy Now!" / "Democracy Now! Rebroadcast")
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  // 2. they agree on a substantial opening phrase
  //    ("We Decide Rebroadcast" / "We Decide: America at the Crossroads")
  //    ("Radio GBE- NYC" / "Radio GBE-New York")
  if (prefixWords(na, nb).length >= 9) return true;
  // 3. same words, different order or filler
  const A = keyset(a), B = keyset(b);
  if (A.size && B.size) {
    let hit = 0;
    for (const w of A) if (B.has(w)) hit++;
    if (hit >= Math.min(A.size, B.size) && hit >= 2) return true;
  }
  // 4. one of them is misspelled ("Ablitionist" / "Abolitionist")
  return dice(na, nb) >= 0.72;
}

// ------------------------------------------------------ diagnosing no-feed

/**
 * Why does a show that advertises a feed have none? Pure, so it can be tested;
 * the two mechanisms below were established from public data on 2026-08-08 and
 * are the whole reason this function can say anything useful.
 *
 * **Feed generation is show-level and RETROACTIVE.** `soundreb` sat with an
 * empty feed and a single Jul 29 recording; a confessor change published that
 * already-recorded episode the same day. So a podcast-side fix does reach back
 * over whatever is still in retention — you do not have to wait for the next
 * broadcast.
 *
 * **`Private` is per RECORDING and is not cleared retroactively.** At the same
 * moment, `ftsb`'s two recordings still carried `private="1"` after the show's
 * Private box was unticked, and its feed stayed empty. Nothing published because
 * nothing was eligible. Those episodes are only recoverable if the flag can be
 * cleared on the recordings themselves, and they expire on schedule regardless.
 *
 * Hence the split: "private since the cutover" is a different instruction to the
 * human than "not private", and both are different from "this show has not
 * recorded under the current configuration at all".
 */
function whyNoFeed(rec, cutover) {
  // Nothing recorded since the cutover: this describes the OLD setup. The show
  // was likely retired or renamed when the schedule was rebuilt, so its
  // confessor record is a ghost to chase, not a bug to fix.
  if (rec.since === 0) {
    return { kind: 'no-feed-old', why:
      `no recording since the ${cutover} config cutover — OLD CONFIG, likely retired or renamed rather than broken; confirm the slot still exists before chasing it` };
  }
  if (rec.priv >= rec.since && rec.priv > 0) {
    return { kind: 'no-feed', why:
      'every recording since the cutover is private=1 — confessor: untick Private. It is stored per RECORDING, so unticking it on the show does NOT publish episodes already recorded; those need the flag cleared on the recordings themselves, before they expire' };
  }
  if (rec.priv > 0) {
    return { kind: 'no-feed', why:
      `${rec.priv} of ${rec.rows} recordings are private=1 — confessor: check Private on the recordings, not just the show` };
  }
  return { kind: 'no-feed', why:
    'not private, so the podcast side is what is off — check this show\'s own confessor record: the Podcast box and "# In Podcast". A fix there publishes retained episodes retroactively (soundreb did, 2026-08-08)' };
}

// ---------------------------------------------------------------- audit

async function run() {
  const started = new Date();
  const [a2html, schedHtml, appRes] = await Promise.all([
    getText(ARCHIVE2),
    getText(WBAI_SCHED),
    getText(APP + '/api/archive'),
  ]);

  const rows = parseArchive2(a2html);
  const slots = weeklySlots(parseWbaiGrid(schedHtml));
  const ours = JSON.parse(appRes).shows || [];

  if (!rows.length) throw new Error('archive2 parsed to 0 rows — their markup changed; fix the parser before trusting anything below');
  if (!slots.length) throw new Error('wbai.org/schedule parsed to 0 slots — their page changed; fix the parser');

  // slug -> what upstream says about it
  const up = new Map();
  for (const r of rows) {
    const rec = up.get(r.sho) || { sho: r.sho, title: r.title, rows: 0, since: 0, priv: 0, rss: 0, newest: 0, minDaysLeft: 999 };
    rec.rows++;
    // Rows recorded under the CURRENT configuration. A show with none of these
    // has told us nothing about how it is set up today.
    if (r.dt >= CUTOVER_TS) rec.since++;
    if (r.private) rec.priv++;
    if (r.hasRSS) rec.rss++;
    if (r.dt > rec.newest) { rec.newest = r.dt; rec.title = r.title || rec.title; }
    if (r.daysLeft >= 0) rec.minDaysLeft = Math.min(rec.minDaysLeft, r.daysLeft);
    up.set(r.sho, rec);
  }
  const staleRows = rows.filter((r) => r.dt && r.dt < CUTOVER_TS).length;
  const mine = new Set(ours.map((r) => r.sho));
  const claimed = [...up.values()].filter((r) => r.rss > 0);
  const unclaimed = [...up.values()].filter((r) => r.rss === 0);

  const findings = [];
  const add = (kind, id, msg, extra) => findings.push({ kind, id, msg, ...extra });

  // 1. Claims a feed, we hold nothing. This is the Soundboard shape.
  for (const r of claimed) {
    if (mine.has(r.sho)) continue;
    const v = whyNoFeed(r, CUTOVER);
    add(v.kind, r.sho, `${r.title || r.sho}: archive2 advertises a feed, app holds nothing`, {
      rows: r.rows, since: r.since, private: r.priv, daysLeft: r.minDaysLeft, why: v.why,
    });
  }

  // 2. The scrape fallback leaking back in. Should be structurally impossible;
  //    if it ever fires, the feed-only rule has been softened somewhere.
  for (const r of unclaimed) {
    if (mine.has(r.sho)) {
      add('leak', r.sho, `${r.title || r.sho}: no getrss link upstream, yet the app holds it — feed-only rule broken?`, { rows: r.rows });
    }
  }

  // 3. We hold a show upstream no longer lists anywhere. Expected occasionally
  //    (see the heavywaits case in server.js); a wave of them means the scrape
  //    broke, not that WBAI cancelled forty shows.
  const gone = [...mine].filter((s) => !up.has(s));
  for (const s of gone) add('feed-only', s, `app holds ${s}, absent from today's archive2 listing entirely`, {});
  if (gone.length > 15) add('scrape', '-', `${gone.length} slugs vanished from the listing at once — suspect a broken scrape, not real delistings`, {});

  // 4. The station says it airs; nothing we hold looks like it. The only check
  //    that can see a show which was never recorded at all.
  const heldTitles = [...new Set(ours.map((r) => r.title))];
  const upTitles = [...new Set(rows.map((r) => r.title))];
  for (const slot of slots) {
    if (heldTitles.some((t) => looksLike(t, slot.title))) continue;
    const onUpstream = upTitles.find((t) => looksLike(t, slot.title));
    add(onUpstream ? 'slot-unheld' : 'slot-unmatched', `${DAYS[slot.day]} ${slot.time}`,
      `${DAYS[slot.day]} ${slot.time} "${slot.title}" — ` +
      (onUpstream ? `recorded upstream as "${onUpstream}" but the app holds no episode` : 'no episode in the app and no obvious archive2 row (title may just differ)'),
      { title: slot.title });
  }

  // ---- optional proof, only for the slugs already flagged
  if (OPT.probe) {
    const targets = findings.filter((f) => f.kind === 'no-feed' || f.kind === 'no-feed-old').slice(0, PROBE_CAP);
    for (const f of targets) {
      const xml = await head(`${ARCHIVE2}xml/${encodeURIComponent(f.id)}.xml`);
      const rss = await head(`${ARCHIVE2}getrss.php?id=${encodeURIComponent(f.id)}`);
      f.probe = { xml: `${xml.status}/${xml.bytes}b`, getrss: `${rss.status}/${rss.bytes}b/${rss.items} items` };
      // A feed that is suddenly serving items is the good news this tool exists
      // to deliver: it means the fix landed and the next harvest will pick it up.
      if (rss.items > 0 || xml.items > 0) f.msg += '  ** FEED IS NOW LIVE — next harvest should pick it up **';
    }
  }

  return {
    at: started.toISOString(),
    app: APP,
    cutover: CUTOVER,
    counts: {
      archive2Rows: rows.length, archive2Slugs: up.size,
      claimFeed: claimed.length, noFeedLink: unclaimed.length,
      appSlugs: mine.size, weeklySlots: slots.length,
      staleRows,
    },
    findings,
  };
}

// ------------------------------------------------------- week-over-week

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
}
function saveState(report) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
  fs.renameSync(tmp, STATE);      // atomic, same rule the server writes under
}
const fid = (f) => `${f.kind}:${f.id}`;

function diff(prev, now) {
  const before = new Set((prev?.findings || []).map(fid));
  const after = new Set(now.findings.map(fid));
  return {
    isNew: now.findings.filter((f) => !before.has(fid(f))),
    resolved: (prev?.findings || []).filter((f) => !after.has(fid(f))),
    since: prev?.at || null,
  };
}

// ---------------------------------------------------------------- output

function render(report, d) {
  const c = report.counts;
  const L = [];
  L.push(`schedule-audit  ${report.at}`);
  L.push(`archive2: ${c.archive2Rows} rows / ${c.archive2Slugs} shows (${c.claimFeed} claim a feed, ${c.noFeedLink} do not)`);
  L.push(`app: ${c.appSlugs} shows   wbai.org: ${c.weeklySlots} weekly slots`);
  L.push(`config cutover ${report.cutover} — ${c.staleRows} of ${c.archive2Rows} rows predate it (OLD CONFIG, not current intent)`);
  L.push('');

  if (!report.findings.length) {
    L.push('nothing to report — every show the station lists is reachable in the app');
  } else {
    // Loudest first, and `no-feed-old` deliberately below the live ones: it is
    // context, not a job.
    const order = ['no-feed', 'leak', 'scrape', 'slot-unheld', 'no-feed-old', 'feed-only', 'slot-unmatched'];
    for (const kind of order) {
      const g = report.findings.filter((f) => f.kind === kind);
      if (!g.length) continue;
      L.push(`## ${kind}  (${g.length})`);
      for (const f of g) {
        L.push(`  - ${f.msg}`);
        if (f.why) L.push(`      why: ${f.why}`);
        if (f.rows !== undefined) L.push(`      rows: ${f.rows}${f.private ? `, private: ${f.private}` : ''}${f.daysLeft !== undefined && f.daysLeft < 999 ? `, days left: ${f.daysLeft}` : ''}`);
        if (f.probe) L.push(`      probe: xml ${f.probe.xml}, getrss ${f.probe.getrss}`);
      }
      L.push('');
    }
  }

  if (d.since) {
    L.push(`## since last run (${d.since})`);
    if (!d.isNew.length && !d.resolved.length) L.push('  no change');
    for (const f of d.isNew) L.push(`  NEW       ${f.msg}`);
    for (const f of d.resolved) L.push(`  RESOLVED  ${f.msg}`);
  } else {
    L.push('(first run — no previous snapshot to diff against)');
  }
  return L.join('\n');
}

// The parsers and the matcher are the parts that can be wrong silently, so they
// are exported and exercised offline by test/schedule-audit/. Requiring this
// file must never touch the network — hence the main guard.
module.exports = { parseArchive2, parseWbaiGrid, weeklySlots, looksLike, dice, prefixWords, diff, whyNoFeed };

if (require.main === module) {
  run().then((report) => {
    const prev = loadState();
    const d = diff(prev, report);
    if (OPT.json) console.log(JSON.stringify({ report, diff: d }, null, 2));
    else console.log(render(report, d));
    if (OPT.save) saveState(report);
    if (OPT.strict && d.isNew.length) process.exit(1);
  }).catch((e) => {
    console.error('schedule-audit failed:', e.message);
    process.exit(2);
  });
}
