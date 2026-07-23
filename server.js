'use strict';

/**
 * WBAI Archive — light, zero-dependency Node server.
 *
 * Responsibilities:
 *   - Serve the static front-end from ./public
 *   - GET /api/archive     live scrape of archive2.wbai.org -> JSON (cached)
 *   - GET /api/nowplaying  proxy of the on-air / up-next feed -> JSON (cached)
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

const UPSTREAM = {
  archive: 'https://archive2.wbai.org/',
  schedule: 'https://confessor2.wbai.org/playlist/pub_sched.php',
  nowplaying: 'https://confessor2.wbai.org/playlist/_pl_current_ary.php',
  pixBase: 'https://confessor2.wbai.org/pix/',
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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'wbai-archive/1.0 (+https://github.com/Catskill909/wbai-archive)' },
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

// --------------------------------------------------------------- nowplaying

const nowCache = makeCache(15 * 1000); // 15 seconds

async function getNowPlaying() {
  const cached = nowCache.get();
  if (cached) return cached;
  const text = await fetchText(UPSTREAM.nowplaying);
  const data = JSON.parse(text);
  const cur = (data[1] && data[1].current) || {};
  const nxt = (data[2] && data[2].next) || {};
  // rewrite the upstream photo URL to our own image proxy path
  let photo = '';
  const pm = (cur.sh_photo || '').match(/pix\/([A-Za-z0-9_]+_med_\d+\.jpg)/);
  if (pm) photo = `/pix/${pm[1]}`;
  const payload = {
    updated: Date.now(),
    current: {
      name: (cur.sh_name || '').trim(),
      dj: (cur.sh_djname || '').trim(),
      start: cur.cur_start || '',
      end: cur.cur_end || '',
      photo,
    },
    next: {
      name: (nxt.sh_name || '').trim(),
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

function serveStatic(reqPath, res) {
  let rel = decodeURIComponent(reqPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  // resolve safely inside PUBLIC_DIR
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA-ish fallback to index for unknown non-asset routes
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
          if (e2) { res.writeHead(404); return res.end('not found'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'], ...securityHeaders() });
          res.end(idx);
        });
      }
      res.writeHead(404); return res.end('not found');
    }
    const ext = path.extname(filePath);
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cache,
      ...securityHeaders(),
    });
    res.end(buf);
  });
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
    if (url === '/healthz') {
      return sendJson(res, { ok: true });
    }
    if (url.startsWith('/pix/')) {
      return proxyPix(url.slice('/pix/'.length).split('?')[0], res);
    }
    return serveStatic(url, res);
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
});
