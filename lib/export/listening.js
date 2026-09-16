'use strict';

/**
 * The `listening` export — the usage counters from stats/, as data.
 *
 * Pure: the server hands in the day records, a title lookup and the zone
 * labels, and both formats (CSV, JSON) and every test read the one object this
 * returns. See docs/exports.md "Phase 1".
 *
 * Periods are an explicit from/to span of UTC days, validated by the caller
 * (the studio offers presets: this month, last month, this year, all time).
 * Days are the UTC days the counters were bucketed into at
 * write time; they cannot be re-split into station-local days afterwards, so
 * the column says `date_utc` and the manifest names both clocks.
 */
const SCHEMA_VERSION = 1;

/**
 * The counters of one day record, each a finite number. Shared with the
 * dashboard's usageReport() so the export and the studio read a day the same
 * way and cannot disagree. A record written by an older build can lack a
 * counter added later (see statsDay() in server.js); that is a real zero for
 * the period before the counter existed, not a missing value.
 */
const DAY_COUNTERS = ['pageviews', 'plays', 'live', 'searches', 'shares', 'listenSeconds', 'liveSeconds'];
function dayCounters(rec) {
  const out = {};
  for (const k of DAY_COUNTERS) out[k] = rec && Number.isFinite(rec[k]) ? rec[k] : 0;
  return out;
}

// The column lists ARE the allow-list: toCsv writes only these, JSON rows are
// built from them, and test/pacifica/export.test.js fails on anything else.
const COLUMNS = {
  daily: ['station', 'date_utc', 'page_views', 'episode_plays', 'live_tune_ins', 'searches', 'shares',
    'seconds_listened_on_demand', 'seconds_listened_live'],
  shows: ['station', 'show_key', 'show_title', 'plays', 'seconds_listened'],
  reach: ['station', 'bucket', 'label', 'page_views'],
};

const COLUMN_NOTES = {
  daily: {
    station: 'Station id. Identical in every row, so files from several stations can be stacked.',
    date_utc: 'The UTC calendar day the counters were recorded in (YYYY-MM-DD). Days with no activity are included as zeros.',
    page_views: 'Times the listener app was opened.',
    episode_plays: 'Times an archived episode was started.',
    live_tune_ins: 'Times the live stream was started.',
    searches: 'Times a search was made. The words searched are never collected.',
    shares: 'Times a share link was made.',
    seconds_listened_on_demand: 'Seconds of archived episodes listened to, unrounded.',
    seconds_listened_live: 'Seconds of the live stream listened to, unrounded.',
  },
  shows: {
    station: 'Station id.',
    show_key: 'The show\'s slug in WBAI\'s archive — the name of its podcast feed (archive2.wbai.org/xml/<slug>.xml).',
    show_title: 'The show\'s title from its feed, or from the station\'s show record. Empty when nothing names the show — never filled with the slug.',
    plays: 'Episode plays for this show in the period.',
    seconds_listened: 'Seconds listened to this show in the period, unrounded. Rows are ranked by this.',
  },
  reach: {
    station: 'Station id.',
    bucket: 'local, national, intl or unknown.',
    label: 'What the bucket means. "local" is the station\'s timezone, which is a clock, not a city.',
    page_views: 'Page views whose browser reported a timezone in this bucket.',
  },
};

const NO_IDENTIFIER = 'These figures are counters only. The app never collects an IP address, cookie, '
  + 'session, device, user agent or the words anyone searched for, so no row in this export can '
  + 'identify or link a listener. That is a property of what is collected, not a filter applied '
  + 'to this file.';

/** Every UTC date from `from` to `to` inclusive, oldest first. */
function spanDates(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z'); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} o.station          station id
 * @param {string} o.stationTimezone  IANA zone in force when the export runs
 * @param {string} o.from             first UTC date, YYYY-MM-DD (validated by the caller)
 * @param {string} o.to               last UTC date, inclusive
 * @param {(m: string) => object} o.monthDays  a month's day records ({} for a month with none)
 * @param {(key: string) => string} o.titleFor  a show title, or '' when nothing names it
 * @param {{key: string, label: string}[]} o.zones  reach buckets, in order
 * @param {string} o.generatedAt      ISO timestamp
 */
function buildListeningExport(o) {
  const dates = spanDates(o.from, o.to);
  const cache = new Map();
  const recFor = (d) => {
    const m = d.slice(0, 7);
    if (!cache.has(m)) cache.set(m, o.monthDays(m) || {});
    return cache.get(m)[d] || null;
  };

  const daily = [];
  const plays = new Map(), seconds = new Map(), zones = new Map();
  const add = (map, from) => {
    for (const [k, n] of Object.entries(from || {})) if (Number.isFinite(n)) map.set(k, (map.get(k) || 0) + n);
  };
  for (const d of dates) {
    const rec = recFor(d), c = dayCounters(rec);
    daily.push({
      station: o.station, date_utc: d, page_views: c.pageviews, episode_plays: c.plays,
      live_tune_ins: c.live, searches: c.searches, shares: c.shares,
      seconds_listened_on_demand: c.listenSeconds, seconds_listened_live: c.liveSeconds,
    });
    if (rec) { add(plays, rec.byShow); add(seconds, rec.secondsByShow); add(zones, rec.byZone); }
  }

  const shows = [...new Set([...plays.keys(), ...seconds.keys()])]
    .map((key) => ({
      station: o.station, show_key: key, show_title: o.titleFor(key) || '',
      plays: plays.get(key) || 0, seconds_listened: seconds.get(key) || 0,
    }))
    .sort((a, b) => (b.seconds_listened - a.seconds_listened) || (b.plays - a.plays)
      || (a.show_key < b.show_key ? -1 : a.show_key > b.show_key ? 1 : 0));

  const reach = o.zones.map((z) => ({ station: o.station, bucket: z.key, label: z.label, page_views: zones.get(z.key) || 0 }));

  return {
    manifest: {
      dataset: 'listening',
      station: o.station,
      station_timezone: o.stationTimezone,
      schema_version: SCHEMA_VERSION,
      generated_at: o.generatedAt,
      from_date_utc: o.from,
      to_date_utc: o.to,
      days_covered: dates.length,
      bucketing: 'UTC calendar day. Counters are assigned to a UTC day when they are recorded and cannot be '
        + `re-split into ${o.stationTimezone} days afterwards.`,
      personal_data: NO_IDENTIFIER,
      tables: Object.fromEntries(Object.keys(COLUMNS).map((t) => [t, COLUMNS[t].map((c) => ({ column: c, meaning: COLUMN_NOTES[t][c] }))])),
    },
    daily, shows, reach,
  };
}

/** One naming scheme for every file, so a folder of them sorts and reads. */
function exportFilename(m, table, ext) {
  const span = `${m.from_date_utc}_${m.to_date_utc}`;
  if (ext === 'csv') return `${m.station}-listening-${table}-${span}.csv`;
  if (ext === 'json') return `${m.station}-listening-${span}.json`;
  return `${m.station}-listening-${span}-README.txt`;
}

/** The README.txt that travels beside the CSVs: the manifest, readable. */
function manifestText(m) {
  const lines = [
    `${m.station.toUpperCase()} listening export`,
    '',
    `Station:          ${m.station}`,
    `Dates (UTC):      ${m.from_date_utc} to ${m.to_date_utc} (${m.days_covered} days)`,
    `Generated:        ${m.generated_at}`,
    `Schema version:   ${m.schema_version}`,
    `Station timezone: ${m.station_timezone}`,
    `Days:             ${m.bucketing}`,
    '',
    'Personal data',
    `  ${m.personal_data}`,
  ];
  for (const [table, cols] of Object.entries(m.tables)) {
    lines.push('', `Table "${table}" (${exportFilename(m, table, 'csv')})`);
    for (const c of cols) lines.push(`  ${c.column}: ${c.meaning}`);
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { buildListeningExport, manifestText, exportFilename, dayCounters, spanDates, COLUMNS, SCHEMA_VERSION, NO_IDENTIFIER };
