'use strict';

/**
 * The `inventory` export (shown as *Archive* in the studio) — every episode
 * this app holds, on the day it is exported.
 *
 * WBAI's source is `feeds.json`: what each show's podcast feed carries now,
 * PLUS the episodes kept after they rotated out of upstream's ~5-item window
 * (mergeFeedItems in server.js). Those older rows exist nowhere else, which is
 * what makes a dated copy of this worth having. It is the same store the
 * studio's "Every feed" dashboard counts, so the two agree.
 *
 * Episodes are selected by AIR DATE IN THE STATION'S TIMEZONE, not UTC: a
 * board asks what aired in September in New York, and a 9 pm show would
 * otherwise land on the next UTC day. (The listening export stays on UTC days
 * because its counters were bucketed that way when recorded; air dates are
 * exact times and can be placed in any clock.) Pure — see docs/exports.md.
 */
const { localDateTime, isoUtc, readmeText, tablesManifest } = require('./common');

const SCHEMA_VERSION = 1;

const COLUMNS = {
  episodes: ['station', 'show_key', 'show_title', 'episode_title', 'air_date_local', 'air_time_local',
    'air_datetime_utc', 'duration_seconds', 'file_bytes', 'category', 'host', 'audio_url'],
  shows: ['station', 'show_key', 'show_title', 'episodes', 'oldest_air_date_local',
    'newest_air_date_local', 'total_seconds', 'total_bytes'],
};

const NOTES = {
  episodes: {
    station: 'Station id.',
    show_key: 'The show\'s slug in WBAI\'s archive — the name of its podcast feed.',
    show_title: 'The show\'s title. Empty when nothing names the show — never filled with the slug.',
    episode_title: 'The episode\'s title as the feed gives it.',
    air_date_local: 'Air date in the station\'s timezone (YYYY-MM-DD). Episodes are selected by this date.',
    air_time_local: 'Air time in the station\'s timezone, 24-hour (HH:MM).',
    air_datetime_utc: 'The same moment in UTC, ISO 8601.',
    duration_seconds: 'Length in seconds, unrounded. 0 when the feed reports no duration.',
    file_bytes: 'Size of the audio file in bytes, as the feed states it. 0 when it does not.',
    category: 'Category as the feed labels it.',
    host: 'Host as the show\'s feed names them.',
    audio_url: 'The episode\'s audio file on WBAI\'s archive server. Unique per episode.',
  },
  shows: {
    station: 'Station id.',
    show_key: 'The show\'s slug in WBAI\'s archive.',
    show_title: 'The show\'s title. Empty when nothing names the show.',
    episodes: 'Episodes of this show in the date span.',
    oldest_air_date_local: 'Earliest air date among them, station timezone.',
    newest_air_date_local: 'Latest air date among them, station timezone.',
    total_seconds: 'Their combined length in seconds, unrounded.',
    total_bytes: 'Their combined file size in bytes.',
  },
};

const PERSONAL = 'This file describes the station\'s programs and episodes as published in WBAI\'s '
  + 'public podcast feeds. It contains no listener data of any kind.';

const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

/**
 * @param {object} o
 * @param {string} o.station
 * @param {string} o.stationTimezone
 * @param {string} o.from   first local air date, YYYY-MM-DD (validated by the caller)
 * @param {string} o.to     last local air date, inclusive
 * @param {object} o.feeds  the feed store: { slug: { channel, items: [{ mp3, bytes, title, dt, durationSec, category }] } }
 * @param {(key: string) => string} o.titleFor
 * @param {string} o.generatedAt
 */
function buildInventory(o) {
  const rows = [];
  let undated = 0;
  for (const [slug, rec] of Object.entries(o.feeds || {})) {
    for (const it of (rec && rec.items) || []) {
      // An item with no parseable pubDate has no air date to select by. Counted
      // in the manifest rather than dropped silently.
      if (!it || !it.mp3) continue;
      if (!(it.dt > 0)) { undated++; continue; }
      rows.push({ slug, it, author: (rec.channel && rec.channel.author) || '' });
    }
  }
  rows.sort((a, b) => (a.it.dt - b.it.dt) || (a.it.mp3 < b.it.mp3 ? -1 : a.it.mp3 > b.it.mp3 ? 1 : 0));

  const episodes = [];
  const shows = new Map();
  for (const { slug, it, author } of rows) {
    const local = localDateTime(it.dt, o.stationTimezone);
    if (local.date < o.from || local.date > o.to) continue;
    const title = o.titleFor(slug) || '';
    episodes.push({
      station: o.station, show_key: slug, show_title: title,
      episode_title: it.title || '', air_date_local: local.date, air_time_local: local.time,
      air_datetime_utc: isoUtc(it.dt), duration_seconds: count(it.durationSec), file_bytes: count(it.bytes),
      category: it.category || '', host: author, audio_url: it.mp3,
    });
    const s = shows.get(slug) || { station: o.station, show_key: slug, show_title: title, episodes: 0,
      oldest_air_date_local: local.date, newest_air_date_local: local.date, total_seconds: 0, total_bytes: 0 };
    s.episodes++;
    if (local.date < s.oldest_air_date_local) s.oldest_air_date_local = local.date;
    if (local.date > s.newest_air_date_local) s.newest_air_date_local = local.date;
    s.total_seconds += count(it.durationSec);
    s.total_bytes += count(it.bytes);
    shows.set(slug, s);
  }
  return {
    manifest: {
      dataset: 'inventory',
      station: o.station,
      station_timezone: o.stationTimezone,
      schema_version: SCHEMA_VERSION,
      generated_at: o.generatedAt,
      from_air_date_local: o.from,
      to_air_date_local: o.to,
      episodes: episodes.length,
      shows: shows.size,
      undated_skipped: undated,
      selection: `Every episode this app holds — what each show's podcast feed carries now, plus the episodes kept `
        + `after they rotated out of the feed — whose air date in ${o.stationTimezone} falls in the span. `
        + 'Held is not a promise the audio still plays: WBAI removes older audio on its own per-show schedule.',
      personal_data: PERSONAL,
      tables: tablesManifest(COLUMNS, NOTES),
    },
    episodes,
    shows: [...shows.values()].sort((a, b) => (a.show_title || a.show_key).localeCompare(b.show_title || b.show_key)),
  };
}

function exportFilename(m, table, ext) {
  const span = `${m.from_air_date_local}_${m.to_air_date_local}`;
  if (ext === 'csv') return `${m.station}-archive-${table}-${span}.csv`;
  if (ext === 'json') return `${m.station}-archive-${span}.json`;
  return `${m.station}-archive-${span}-README.txt`;
}

function manifestText(m) {
  return readmeText(m, `${m.station.toUpperCase()} archive export`, [
    ['Station', m.station],
    ['Air dates', `${m.from_air_date_local} to ${m.to_air_date_local} (${m.station_timezone})`],
    ['Held', `${m.episodes} episodes of ${m.shows} shows`],
    ['Generated', m.generated_at],
    ['Schema version', String(m.schema_version)],
    ['Selection', m.selection],
  ]);
}

module.exports = { buildInventory, manifestText, exportFilename, COLUMNS, SCHEMA_VERSION };
