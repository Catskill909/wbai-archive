'use strict';

/**
 * The `coverage` export — where the data is thin, one row per show. A snapshot
 * of right now, so it takes no date span.
 *
 * WBAI has no published catalog to list every show, so the rows are every slug
 * WBAI's archive listing has ever named (known-slugs.json) plus every show this
 * app holds a feed for. That union is what makes the biggest gap visible: a show
 * the listing names but that publishes no podcast feed has no episodes in this
 * app at all (the app is feed-only — docs/missing-show.md).
 *
 * WBAI also has no published schedule (the app derives its schedule from the
 * archive rows), so there is no `in_published_schedule` column. Pure — see
 * docs/exports.md.
 */
const { localDateTime, readmeText, tablesManifest } = require('./common');

const SCHEMA_VERSION = 1;

/**
 * An image shared by this many shows or more is not any show's own artwork.
 *
 * Same class KPFK found on 2026-09-16 (Pacifica filling a missing picture with
 * a generic station one): on 2026-09-16 WBAI's feeds gave 17 shows
 * `…/pix/WBAI_it_.jpg`. No real show image is shared by even two shows, so a
 * count works without knowing the file name.
 */
const GENERIC_ARTWORK_MIN_SHOWS = 4;

const COLUMNS = {
  shows: ['station', 'show_key', 'show_title', 'has_feed', 'has_artwork', 'has_description', 'has_host',
    'in_program_directory', 'episodes_held', 'newest_air_date_local', 'days_since_newest_episode'],
};

const NOTES = {
  shows: {
    station: 'Station id.',
    show_key: 'The show\'s slug in WBAI\'s archive.',
    show_title: 'The show\'s title. Empty when nothing names the show — itself a gap worth fixing.',
    has_feed: 'true when this app holds a podcast feed with episodes for the show. The app is feed-only: a show without one has no episodes here.',
    has_artwork: 'true when the show has its OWN image: from WBAI\'s schedule page, its show record, or its feed. An image shared by 4 or more shows (a generic station picture) does not count; the JSON summary lists any such image.',
    has_description: 'true when the show record or the feed describes the show.',
    has_host: 'true when the show record or the feed names a host.',
    in_program_directory: 'true when the show\'s title matches a program on wbai.org\'s program directory. The match is by title and approximate — the directory is keyed by name, the archive by slug.',
    episodes_held: 'Episodes this app holds for the show, including those kept after they left the feed.',
    newest_air_date_local: 'Air date of its newest episode, station timezone. Empty with no episodes.',
    days_since_newest_episode: 'Whole days from that episode\'s air time to the export. Empty with no episodes.',
  },
};

const PERSONAL = 'This file describes the station\'s programs as published in WBAI\'s public archive '
  + 'and feeds. It contains no listener data of any kind.';

const text = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * @param {object} o
 * @param {string} o.station
 * @param {string} o.stationTimezone
 * @param {object} o.feeds             the feed store { slug: { channel, items } }
 * @param {Iterable<string>} o.knownSlugs  every slug the listing has named
 * @param {object} o.showInfo          show records { slug: { name, dj, desc, photo } }
 * @param {object} o.photoMap          schedule-page photo ids { slug: id }
 * @param {(key: string, title: string) => boolean} o.inDirectory
 * @param {(key: string) => string} o.titleFor
 * @param {number} o.now               epoch ms at export
 * @param {string} o.generatedAt
 */
function buildCoverage(o) {
  const feeds = o.feeds || {}, info = o.showInfo || {}, photos = o.photoMap || {};
  const urlUse = new Map();
  for (const rec of Object.values(feeds)) {
    const u = rec && rec.channel && rec.channel.image;
    if (u) urlUse.set(u, (urlUse.get(u) || 0) + 1);
  }
  const generic = new Set([...urlUse].filter(([, n]) => n >= GENERIC_ARTWORK_MIN_SHOWS).map(([u]) => u));

  const keys = [...new Set([...Object.keys(feeds), ...o.knownSlugs])].sort();
  const shows = keys.map((key) => {
    const rec = feeds[key], ch = (rec && rec.channel) || {}, si = info[key] || {};
    const items = ((rec && rec.items) || []).filter((it) => it && it.mp3);
    const newest = items.reduce((m, it) => (it.dt > m ? it.dt : m), 0);
    const title = o.titleFor(key) || '';
    return {
      station: o.station,
      show_key: key,
      show_title: title,
      has_feed: items.length > 0,
      has_artwork: !!photos[key] || text(si.photo) || (text(ch.image) && !generic.has(ch.image)),
      has_description: text(si.desc) || text(ch.desc),
      has_host: text(si.dj) || text(ch.author),
      in_program_directory: !!title && o.inDirectory(key, title),
      episodes_held: items.length,
      newest_air_date_local: newest ? localDateTime(newest, o.stationTimezone).date : '',
      days_since_newest_episode: newest ? Math.max(0, Math.floor((o.now / 1000 - newest) / 86400)) : '',
    };
  });
  const count = (f) => shows.filter(f).length;
  return {
    manifest: {
      dataset: 'coverage',
      station: o.station,
      station_timezone: o.stationTimezone,
      schema_version: SCHEMA_VERSION,
      generated_at: o.generatedAt,
      as_of_utc: o.generatedAt,
      shows: shows.length,
      selection: 'Every show WBAI\'s archive listing has ever named, plus every show this app holds a feed for.',
      summary: {
        with_feed: count((s) => s.has_feed),
        without_feed: count((s) => !s.has_feed),
        without_artwork: count((s) => !s.has_artwork),
        without_description: count((s) => !s.has_description),
        without_host: count((s) => !s.has_host),
        not_in_program_directory: count((s) => !s.in_program_directory),
      },
      generic_artwork: [...generic].map((url) => ({ url, shows: urlUse.get(url) })),
      personal_data: PERSONAL,
      tables: tablesManifest(COLUMNS, NOTES),
    },
    shows,
  };
}

function exportFilename(m, table, ext) {
  const day = m.as_of_utc.slice(0, 10);
  if (ext === 'csv') return `${m.station}-coverage-${table}-${day}.csv`;
  if (ext === 'json') return `${m.station}-coverage-${day}.json`;
  return `${m.station}-coverage-${day}-README.txt`;
}

function manifestText(m) {
  const s = m.summary;
  return readmeText(m, `${m.station.toUpperCase()} coverage export`, [
    ['Station', m.station],
    ['As of', m.as_of_utc],
    ['Shows', `${m.shows} (${m.selection})`],
    ['With a feed', String(s.with_feed)],
    ['Without a feed', String(s.without_feed)],
    ['Without artwork', String(s.without_artwork)],
    ['Without description', String(s.without_description)],
    ['Without host', String(s.without_host)],
    ['Not in directory', String(s.not_in_program_directory)],
    ['Station timezone', m.station_timezone],
    ['Schema version', String(m.schema_version)],
  ]);
}

module.exports = { buildCoverage, manifestText, exportFilename, COLUMNS, SCHEMA_VERSION };
