'use strict';

/**
 * Shared by every export dataset: dates in the station's own clock, the
 * read-me text, and file names. See docs/exports.md.
 */

const formatters = new Map();
function formatter(timezone) {
  if (!formatters.has(timezone)) {
    formatters.set(timezone, new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return formatters.get(timezone);
}

/** An epoch in seconds as the station's local `YYYY-MM-DD` and `HH:MM`. */
function localDateTime(epochSec, timezone) {
  const parts = formatter(timezone).formatToParts(epochSec * 1000);
  const p = (t) => parts.find((x) => x.type === t).value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, time: `${p('hour')}:${p('minute')}` };
}

function isoUtc(epochSec) { return new Date(epochSec * 1000).toISOString(); }

/** Every date from `from` to `to` inclusive, oldest first (calendar dates, no clock). */
function spanDates(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z'); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Plain-text read-me for any dataset's manifest. `facts` are [label, value] lines. */
function readmeText(m, title, facts) {
  const width = Math.max(...facts.map(([k]) => k.length)) + 2;
  const lines = [title, ''];
  for (const [k, v] of facts) lines.push((k + ':').padEnd(width) + v);
  lines.push('', 'Personal data', `  ${m.personal_data}`);
  for (const [table, cols] of Object.entries(m.tables)) {
    lines.push('', `Table "${table}"`);
    for (const c of cols) lines.push(`  ${c.column}: ${c.meaning}`);
  }
  return lines.join('\r\n') + '\r\n';
}

function tablesManifest(columns, notes) {
  return Object.fromEntries(Object.keys(columns).map((t) =>
    [t, columns[t].map((c) => ({ column: c, meaning: notes[t][c] }))]));
}

module.exports = { localDateTime, isoUtc, spanDates, readmeText, tablesManifest };
