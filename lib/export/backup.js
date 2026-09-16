'use strict';

/**
 * Backup and import — moving a station's data to another server.
 *
 * A WBAI backup is one JSON file: every stats month verbatim, the studio
 * settings, a checksum per month, and the feed store (`feeds.json`) with its own
 * checksum. The feeds are in it because they cannot be re-fetched: WBAI's feeds
 * carry ~5 episodes per show and this app keeps the ones that rotate out, so a
 * move without them loses the archive's depth (CLAUDE.md §4). KPFK's backup has
 * no feeds — Pacifica's JSON can be re-fetched.
 *
 * The two halves restore differently. Months are previewed then REPLACED (the
 * counters are the server's own figures). Feeds are MERGED per show with the
 * app's own mergeFeedItems, passed in by the server: every episode is kept, none
 * duplicated, and this server's copy of an episode wins over the backup's,
 * because it is the more recent telling. Restoring twice changes nothing. It is lossless on purpose — the CSV/JSON reports
 * are for reading; this is for restoring, so an import on a new server gives
 * exactly the numbers the old one had. See docs/exports.md "1c".
 *
 * Pure: the server reads and writes the files; this module builds, validates
 * and plans. Validation is an ALLOW-LIST, not a sanity check. The counters
 * carry no identifier of any kind (README), and an import is a way to put data
 * on the volume that this app did not collect — so a day record may hold the
 * known counters and maps and nothing else. A backup that carries any other
 * field is refused, not trimmed: a file that has been edited should not be
 * half-trusted.
 */
const crypto = require('crypto');

const FORMAT = 'pacifica-archive-backup';
const FORMAT_VERSION = 1;

const COUNTERS = ['pageviews', 'plays', 'live', 'searches', 'shares', 'listenSeconds', 'liveSeconds'];
const MAPS = ['byShow', 'secondsByShow', 'byZone'];
const ZONES = new Set(['local', 'national', 'intl', 'unknown']);
const MONTH_FIELDS = new Set(['station', 'month', 'days']);
// Settings this build knows. Empty until the studio's timezone setting exists
// (HANDOFF open item 2); a backup from a newer build carrying a setting this
// one cannot apply is refused rather than silently dropping it.
const KNOWN_SETTINGS = new Set();

// The feed store's allow-list, field by field (parseFeedXml in server.js).
// `lastModified` and `fetchedAt` are this server's fetch state, not data, so a
// backup does not carry them: a show a restore adds is fetched afresh.
const CHANNEL_FIELDS = ['title', 'desc', 'author', 'image'];
const ITEM_TEXT = ['mp3', 'title', 'desc', 'category'];
const ITEM_COUNTS = ['bytes', 'dt', 'durationSec'];
const FEED_SLUG = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_SHOWS = 5000;
const MAX_TEXT = 100000;
const HTTP_URL = /^https?:\/\/[^\s"<>]{1,2040}$/;

// Bounds on a body that arrives over HTTP. Generous for a real station — ten
// years of months at a few KB each is well under a megabyte — and small enough
// that a hostile or mistaken upload cannot make the server walk forever.
const MAX_MONTHS = 1200;
const MAX_KEYS_PER_MAP = 5000;
// FEED_ITEM_CAP in server.js is 2000 per show; the store cannot hold more.
const MAX_ITEMS_PER_SHOW = 2000;
const SHOW_KEY = /^[A-Za-z0-9_.-]{1,200}$/;

/** The checksum of one month, over its JSON text. Key order is part of it,
 *  which is fine: JSON.parse keeps the order a file was written in. */
function sha256(v) {
  return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
}
function monthChecksum(monthObj) { return sha256(monthObj); }

/**
 * A month as a backup carries it: `station`, `month`, and days holding only the
 * known counters and maps. On a current file that is exactly what is on disk.
 * What it drops is what this app's own policy already deletes — search terms an
 * early WBAI build wrote (stripLegacyTerms in server.js) — so a backup this app
 * makes always passes this app's own import.
 */
function backupMonth(mo, station, m) {
  const days = {};
  for (const [d, rec] of Object.entries((mo && mo.days) || {})) {
    if (!isObject(rec)) continue;
    const out = {};
    for (const k of COUNTERS) if (Object.hasOwn(rec, k)) out[k] = rec[k];
    for (const k of MAPS) if (Object.hasOwn(rec, k)) out[k] = rec[k];
    days[d] = out;
  }
  return { station, month: m, days };
}

/** The feed store as a backup carries it: per show, the channel and the items,
 *  each holding only the known fields. */
function backupFeeds(store) {
  const out = {};
  for (const slug of Object.keys(store || {}).sort()) {
    const rec = store[slug];
    if (!isObject(rec)) continue;
    const channel = {};
    for (const k of CHANNEL_FIELDS) channel[k] = rec.channel && typeof rec.channel[k] === 'string' ? rec.channel[k] : '';
    const items = [];
    for (const it of Array.isArray(rec.items) ? rec.items : []) {
      if (!isObject(it) || typeof it.mp3 !== 'string' || !it.mp3) continue;
      const item = {};
      for (const k of ITEM_TEXT) item[k] = typeof it[k] === 'string' ? it[k] : '';
      for (const k of ITEM_COUNTS) item[k] = isCount(it[k]) ? it[k] : 0;
      items.push(item);
    }
    out[slug] = { channel, items };
  }
  return out;
}

function buildBackup({ station, createdAt, appVersion, sourceInstanceId, months, settings = {}, feeds = {} }) {
  const stats = {};
  const checksums = {};
  for (const m of Object.keys(months).sort()) {
    stats[m] = months[m];
    checksums[m] = monthChecksum(months[m]);
  }
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    station,
    createdAt,
    appVersion,
    sourceInstanceId,
    note: `Usage counters, studio settings and the archive's episodes from the ${station} archive app. `
      + 'Contains no identifier of any kind. Restore it from the studio: Export → Backup & restore.',
    stats,
    settings,
    checksums,
    feeds,
    feedsChecksum: sha256(feeds),
  };
}

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function isCount(n) { return Number.isSafeInteger(n) && n >= 0; }
function realDay(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'))
    && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;
}

/**
 * Check a parsed backup against everything this build will accept.
 * Returns { ok: true, months: {m: monthObj}, settings } or { ok: false, errors: [...] }.
 * Every problem is collected, not just the first, so the studio can show a
 * station manager the whole reason at once.
 *
 * @param {object} b          the parsed file
 * @param {object} o
 * @param {string} o.station  this server's station id
 * @param {string} o.thisMonth the current UTC month, YYYY-MM — later months cannot exist yet
 */
function validateBackup(b, { station, thisMonth }) {
  const errors = [];
  const err = (msg) => { if (errors.length < 50) errors.push(msg); };
  if (!isObject(b)) return { ok: false, errors: ['This is not a backup file (expected a JSON object).'] };
  if (b.format !== FORMAT) return { ok: false, errors: ['This is not a backup made by this app (format is not "' + FORMAT + '").'] };
  if (b.formatVersion !== FORMAT_VERSION) {
    return { ok: false, errors: [`This backup is format version ${JSON.stringify(b.formatVersion)}; this app reads version ${FORMAT_VERSION}.`] };
  }
  if (b.station !== station) {
    return { ok: false, errors: [`This backup belongs to station "${b.station}", and this server is "${station}". Backups can only be restored to the same station.`] };
  }
  if (!isObject(b.stats)) err('The backup has no "stats" section.');
  if (!isObject(b.checksums)) err('The backup has no "checksums" section.');
  if (b.settings !== undefined && !isObject(b.settings)) err('"settings" must be an object.');
  for (const k of Object.keys(isObject(b.settings) ? b.settings : {})) {
    if (!KNOWN_SETTINGS.has(k)) err(`The backup has a setting "${k}" that this version of the app does not know. Update the app first.`);
  }
  if (errors.length) return { ok: false, errors };

  const monthKeys = Object.keys(b.stats);
  if (monthKeys.length > MAX_MONTHS) return { ok: false, errors: [`The backup has ${monthKeys.length} months; at most ${MAX_MONTHS} are accepted.`] };
  for (const m of Object.keys(b.checksums)) {
    if (!Object.hasOwn(b.stats, m)) err(`There is a checksum for ${JSON.stringify(m)} but no data for it.`);
  }
  const months = {};
  for (const m of monthKeys) {
    const where = `Month ${JSON.stringify(m)}`;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) { err(`${where} is not a month (expected YYYY-MM).`); continue; }
    if (m > thisMonth) { err(`${where} is in the future.`); continue; }
    const mo = b.stats[m];
    if (!isObject(mo)) { err(`${where} is not an object.`); continue; }
    if (b.checksums[m] !== monthChecksum(mo)) {
      err(`${where} does not match its checksum — the file was changed or damaged after it was made.`);
      continue;
    }
    for (const f of Object.keys(mo)) if (!MONTH_FIELDS.has(f)) err(`${where} has an unexpected field "${f}".`);
    if (mo.station !== station) err(`${where} is stamped for station "${mo.station}".`);
    if (mo.month !== m) err(`${where} says it is month "${mo.month}".`);
    if (!isObject(mo.days)) { err(`${where} has no days.`); continue; }
    for (const [d, rec] of Object.entries(mo.days)) {
      const dw = `Day ${JSON.stringify(d)}`;
      if (!realDay(d) || d.slice(0, 7) !== m) { err(`${dw} is not a date in ${m}.`); continue; }
      if (!isObject(rec)) { err(`${dw} is not an object.`); continue; }
      for (const [f, v] of Object.entries(rec)) {
        if (COUNTERS.includes(f)) {
          if (!isCount(v)) err(`${dw}: "${f}" must be a whole number of zero or more.`);
        } else if (MAPS.includes(f)) {
          if (!isObject(v)) { err(`${dw}: "${f}" must be an object.`); continue; }
          const entries = Object.entries(v);
          if (entries.length > MAX_KEYS_PER_MAP) err(`${dw}: "${f}" has too many entries.`);
          for (const [k, n] of entries) {
            if (f === 'byZone' ? !ZONES.has(k) : !SHOW_KEY.test(k)) err(`${dw}: "${f}" has an unexpected key ${JSON.stringify(k).slice(0, 80)}.`);
            if (!isCount(n)) err(`${dw}: "${f}.${k}" must be a whole number of zero or more.`);
          }
        } else {
          err(`${dw} has an unexpected field "${f}". A backup holds counters only.`);
        }
      }
    }
    months[m] = mo;
  }
  // A station with counting switched off (USAGE_TRACKING=off) has no months,
  // and its episodes are still worth moving.
  if (!monthKeys.length && !(isObject(b.feeds) && Object.keys(b.feeds).length)) err('The backup contains no months and no episodes.');
  validateFeeds(b, err);
  return errors.length ? { ok: false, errors } : { ok: true, months, settings: b.settings || {}, feeds: b.feeds };
}

/** The feeds half of validateBackup: same rules — refuse, never trim. */
function validateFeeds(b, err) {
  if (!isObject(b.feeds)) { err('The backup has no "feeds" section (the archive\'s episodes).'); return; }
  if (b.feedsChecksum !== sha256(b.feeds)) {
    err('The feeds section does not match its checksum — the file was changed or damaged after it was made.');
    return;
  }
  const slugs = Object.keys(b.feeds);
  if (slugs.length > MAX_SHOWS) { err(`The backup has ${slugs.length} shows; at most ${MAX_SHOWS} are accepted.`); return; }
  const str = (v) => typeof v === 'string' && v.length <= MAX_TEXT;
  for (const slug of slugs) {
    const where = `Show ${JSON.stringify(slug).slice(0, 80)}`;
    if (!FEED_SLUG.test(slug)) { err(`${where} is not a show slug.`); continue; }
    const rec = b.feeds[slug];
    if (!isObject(rec)) { err(`${where} is not an object.`); continue; }
    for (const f of Object.keys(rec)) if (f !== 'channel' && f !== 'items') err(`${where} has an unexpected field "${f}".`);
    if (!isObject(rec.channel)) err(`${where} has no channel.`);
    else {
      for (const [f, v] of Object.entries(rec.channel)) {
        if (!CHANNEL_FIELDS.includes(f)) err(`${where}: the channel has an unexpected field "${f}".`);
        else if (!str(v)) err(`${where}: channel "${f}" must be text.`);
      }
      if (rec.channel.image && !HTTP_URL.test(rec.channel.image)) err(`${where}: the channel image is not a web address.`);
    }
    if (!Array.isArray(rec.items)) { err(`${where} has no list of episodes.`); continue; }
    if (rec.items.length > MAX_ITEMS_PER_SHOW) err(`${where} has ${rec.items.length} episodes; at most ${MAX_ITEMS_PER_SHOW} are accepted.`);
    rec.items.forEach((it, i) => {
      const iw = `${where}, episode ${i + 1}`;
      if (!isObject(it)) { err(`${iw} is not an object.`); return; }
      for (const [f, v] of Object.entries(it)) {
        if (ITEM_TEXT.includes(f)) { if (!str(v)) err(`${iw}: "${f}" must be text.`); }
        else if (ITEM_COUNTS.includes(f)) { if (!isCount(v)) err(`${iw}: "${f}" must be a whole number of zero or more.`); }
        else err(`${iw} has an unexpected field "${f}".`);
      }
      if (typeof it.mp3 !== 'string' || !HTTP_URL.test(it.mp3)) err(`${iw}: the audio address is not a web address.`);
    });
  }
}

/**
 * What restoring the feeds would do, show by show. Nothing on this server is
 * ever removed by a restore, so the only actions are `new` (a show this server
 * does not hold), `merge` (adds episodes to a show it holds) and `identical`.
 *
 * @param {object} incoming  validated backup feeds
 * @param {object} current   this server's feed store
 * @param {(prev: object[], fresh: object[]) => object[]} merge  server.js mergeFeedItems
 */
function planFeeds(incoming, current, merge) {
  const shows = [];
  const t = { backupShows: 0, backupEpisodes: 0, serverShows: 0, serverEpisodes: 0, newShows: 0, showsGaining: 0, episodesAdded: 0 };
  for (const rec of Object.values(current || {})) {
    if (rec && Array.isArray(rec.items) && rec.items.length) { t.serverShows++; t.serverEpisodes += rec.items.length; }
  }
  for (const slug of Object.keys(incoming).sort()) {
    const inc = incoming[slug].items;
    if (!inc.length) continue;
    t.backupShows++; t.backupEpisodes += inc.length;
    const cur = current[slug] && Array.isArray(current[slug].items) ? current[slug].items : [];
    const held = new Set(cur.map((it) => it && it.mp3));
    // Merged exactly as apply will merge it, so the count cannot disagree with
    // what is written — including anything the item cap would drop.
    const merged = merge(inc, cur);
    const adds = merged.filter((it) => !held.has(it.mp3)).map((it) => it.mp3);
    const action = !cur.length ? 'new' : adds.length ? 'merge' : 'identical';
    if (action === 'new') t.newShows++;
    if (adds.length) { t.showsGaining++; t.episodesAdded += adds.length; }
    shows.push({ slug, action, backupEpisodes: inc.length, serverEpisodes: cur.length, adds });
  }
  return { ...t, shows };
}

/** Headline totals of one month, for the preview table. */
function monthSummary(mo) {
  const t = { days: 0, pageviews: 0, plays: 0, listenSeconds: 0, liveSeconds: 0 };
  for (const rec of Object.values((mo && mo.days) || {})) {
    if (!rec) continue;
    t.days++;
    for (const k of ['pageviews', 'plays', 'listenSeconds', 'liveSeconds']) if (Number.isFinite(rec[k])) t[k] += rec[k];
  }
  return t;
}

/**
 * What an import would do, month by month.
 * @param {object} incoming  validated backup months {m: monthObj}
 * @param {object} current   this server's months {m: monthObj}, only those that exist
 */
function planImport(incoming, current) {
  const all = [...new Set([...Object.keys(incoming), ...Object.keys(current)])].sort().reverse();
  return all.map((m) => {
    const inB = Object.hasOwn(incoming, m), here = Object.hasOwn(current, m);
    const action = !inB ? 'kept'
      : !here ? 'new'
      : monthChecksum(current[m]) === monthChecksum(incoming[m]) ? 'identical'
      : 'replace';
    return {
      month: m,
      action,
      backup: inB ? monthSummary(incoming[m]) : null,
      server: here ? monthSummary(current[m]) : null,
    };
  });
}

module.exports = {
  FORMAT, FORMAT_VERSION, backupMonth, backupFeeds, buildBackup, validateBackup, planImport, planFeeds,
  monthSummary, monthChecksum,
};
