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

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHOWINFO_PATH = process.env.SHOWINFO_PATH || path.join(__dirname, 'data', 'showinfo.json');
const PROGRAMS_PATH = process.env.PROGRAMS_PATH || path.join(__dirname, 'data', 'programs.json');
const PROGRAMS_TTL = 24 * 60 * 60 * 1000;

const UPSTREAM = {
  archive: 'https://archive2.wbai.org/',
  schedule: 'https://confessor2.wbai.org/playlist/pub_sched.php',
  nowplaying: 'https://confessor2.wbai.org/playlist/_pl_current_ary.php',
  pixBase: 'https://confessor2.wbai.org/pix/',
  programList: 'https://wbai.org/programlist/',
  program: 'https://wbai.org/program.php?program=',
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

async function fetchText(url, opts) {
  opts = opts || {};
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: Object.assign(
      { 'User-Agent': 'wbai-archive/1.0 (+https://github.com/Catskill909/wbai-archive)' },
      opts.headers
    ),
    body: opts.body,
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  // Upstream pages are declared ISO-8859-1; decode as latin1 to keep bytes intact.
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('latin1');
}

// simple TTL cache
function makeCache(ttlMs) {
  let value = null;
  let ts = 0;
  return {
    get() { return (Date.now() - ts < ttlMs) ? value : null; },
    set(v) { value = v; ts = Date.now(); },
    stale() { return value; },
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

const archiveCache = makeCache(10 * 60 * 1000); // 10 minutes

async function getArchive() {
  const cached = archiveCache.get();
  if (cached) return cached;
  const [html, photoMap] = await Promise.all([
    fetchText(UPSTREAM.archive),
    fetchPhotoMap().catch(() => ({})),
  ]);
  const rows = parseArchive(html, photoMap);
  if (!rows.length) throw new Error('parsed zero rows');
  const payload = { updated: Date.now(), count: rows.length, shows: rows };
  archiveCache.set(payload);
  return payload;
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
    return fallback;
  }
}

const saveTimers = new Map();
function writeJsonSoon(file, getData, delayMs = 10000) {
  if (saveTimers.has(file)) return;
  const t = setTimeout(() => {
    saveTimers.delete(file);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(getData()));
    } catch (e) {
      console.warn(`[cache] ${path.basename(file)} running memory-only:`, e.message);
    }
  }, delayMs);
  if (t.unref) t.unref();
  saveTimers.set(file, t);
}

const showInfo = readJsonFile(SHOWINFO_PATH, {});
let showInfoUpdated = Object.keys(showInfo).length ? Date.now() : 0;

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

function sendFile(req, res, filePath, ext) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res, filePath);
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

// --------------------------------------------------------------- the server

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    return res.end('method not allowed');
  }

  const url = req.url || '/';

  try {
    if (url === '/api/archive') {
      const data = await getArchive();
      return sendJson(res, data, 200, 300);
    }
    if (url === '/api/nowplaying') {
      const data = await getNowPlaying();
      return sendJson(res, data, 200, 10);
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
    if (url === '/healthz') {
      return sendJson(res, { ok: true });
    }
    if (url.startsWith('/pix/')) {
      return proxyPix(url.slice('/pix/'.length).split('?')[0], res);
    }
    return serveStatic(req, url, res);
  } catch (err) {
    // graceful degradation: serve last-good cached data if we have it
    if (url === '/api/archive' && archiveCache.stale()) {
      return sendJson(res, archiveCache.stale(), 200, 60);
    }
    if (url === '/api/nowplaying' && nowCache.stale()) {
      return sendJson(res, nowCache.stale(), 200, 10);
    }
    console.error(`[error] ${url}:`, err.message);
    return sendJson(res, { error: 'upstream unavailable' }, 502);
  }
});

server.listen(PORT, () => {
  console.log(`WBAI Archive server listening on :${PORT}`);
  refreshProgramsIfStale();
});
