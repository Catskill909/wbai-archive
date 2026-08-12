#!/usr/bin/env node
'use strict';

/**
 * A schedule change must retire a show from the current weekly lineup without
 * erasing its playable archive history.
 *
 * This exercises the server's real persisted-store path. The fixture starts the
 * module with a show remembered in known-slugs.json and two older episodes in
 * feeds.json, then supplies no current listing rows for that show. Both episodes
 * must still become `feed-only` archive rows, while a remembered slug with no
 * actual feed must never turn into invented content.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wbai-feed-retirement-'));
process.env.DATA_DIR = tmp;

const retired = 'retiredshow';
const neverFed = 'neverfed';
const items = [
  {
    mp3: 'https://archive2.wbai.org/mp3/wbai_260715_100000retiredshow.mp3',
    bytes: 57000000,
    title: 'Retired Show — July 15',
    dt: Math.floor(Date.parse('2026-07-15T14:00:00Z') / 1000),
    durationSec: 3603,
    desc: 'An episode from the previous lineup.',
    category: 'Public Affairs',
  },
  {
    mp3: 'https://archive2.wbai.org/mp3/wbai_260708_100000retiredshow.mp3',
    bytes: 56000000,
    title: 'Retired Show — July 8',
    dt: Math.floor(Date.parse('2026-07-08T14:00:00Z') / 1000),
    durationSec: 3602,
    desc: 'An older episode retained after the schedule changed.',
    category: 'Public Affairs',
  },
];

fs.writeFileSync(path.join(tmp, 'known-slugs.json'), JSON.stringify([retired, neverFed]));
fs.writeFileSync(path.join(tmp, 'feeds.json'), JSON.stringify({
  [retired]: {
    lastModified: 'Wed, 15 Jul 2026 18:04:55 GMT',
    fetchedAt: Date.parse('2026-08-01T12:00:00Z'),
    channel: {
      title: 'Retired Show',
      desc: 'A show from the previous WBAI lineup.',
      author: 'Former Host',
      image: 'https://confessor2.wbai.org/pix/retiredshow_med_1.jpg',
    },
    items,
  },
}));

let failed = false;
let cleanupOnExit = false;
try {
  const { applyFeeds, unclaimedFeedSlugs } = require('../../server.js');
  // server.js flushes pending writes during process exit. Register cleanup after
  // requiring it so its exit handler runs first and cannot recreate this fixture.
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  cleanupOnExit = true;

  const unclaimed = unclaimedFeedSlugs(['currentshow']);
  assert.deepStrictEqual(
    unclaimed.sort(),
    [neverFed, retired].sort(),
    'today\'s listing must not erase discovery memory from the previous lineup'
  );

  const out = applyFeeds([]);
  assert.strictEqual(out.feedOnly, 2, 'both historical episodes must remain in the archive');
  assert.strictEqual(out.rows.length, 2, 'a remembered slug without a feed must not invent a row');
  assert.ok(out.rows.every((row) => row.sho === retired), 'only the real retired show should render');
  assert.ok(out.rows.every((row) => row.source === 'feed-only'), 'retired rows must not claim to be current listings');
  assert.ok(out.rows.every((row) => row.daysLeft === null), 'retired rows must not invent a retention promise');
  assert.deepStrictEqual(
    new Set(out.rows.map((row) => row.mp3)),
    new Set(items.map((item) => item.mp3)),
    'the server must expose the exact persisted historical recordings'
  );

  console.log('feed-retirement regression\n');
  console.log('  ok   retired show remains discoverable from known-slugs.json');
  console.log('  ok   historical feed episodes render as feed-only archive rows');
  console.log('  ok   remembered slug without a feed creates no phantom content');
  console.log('\n3 passed, 0 failed');
} catch (e) {
  failed = true;
  console.error('feed-retirement regression FAILED\n');
  console.error(e && e.stack ? e.stack : e);
} finally {
  if (!cleanupOnExit) fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) process.exit(1);
