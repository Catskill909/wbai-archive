// Fake Icecast, with real live semantics: one source cursor advances in real
// time at the bitrate, and every client is served from wherever that cursor is
// *now*. There is no rewind and no per-client backlog — exactly like the real
// station, which is the whole point: bytes a client receives can only be live.
//
// Listens on 443 as streaming.wbai.org (Chrome is pointed here with
// --host-resolver-rules), plus a plain-HTTP control API on 8091.
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DIR   = __dirname;
const TONE  = fs.readFileSync(path.join(DIR, 'tone.mp3'));
const TICK_MS = 200;

// Split the file into whole MPEG frames. A client that joins a live stream must
// land on a frame header or the decoder never starts — real Icecast aligns for
// exactly this reason, and Chrome is stricter about it than ffmpeg.
const FRAMES = (() => {
  const BITRATES = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0]; // MPEG1 L3
  const RATES = [44100, 48000, 32000, 0];
  let pos = 0;
  if (TONE.slice(0, 3).toString() === 'ID3') {
    const sz = (TONE[6]<<21) | (TONE[7]<<14) | (TONE[8]<<7) | TONE[9];
    pos = 10 + sz;
  }
  const out = [];
  while (pos + 4 <= TONE.length) {
    if (TONE[pos] !== 0xFF || (TONE[pos+1] & 0xE0) !== 0xE0) { pos++; continue; }
    const br = BITRATES[TONE[pos+2] >> 4];
    const sr = RATES[(TONE[pos+2] >> 2) & 3];
    const pad = (TONE[pos+2] >> 1) & 1;
    if (!br || !sr) { pos++; continue; }
    const len = Math.floor(144000 * br / sr) + pad;
    if (pos + len > TONE.length) break;
    out.push(TONE.subarray(pos, pos + len));
    pos += len;
  }
  return out;
})();
const FPS = 44100 / 1152;                      // MPEG1 Layer III frames per second
console.log(`indexed ${FRAMES.length} frames (${(FRAMES.length / FPS).toFixed(1)}s of audio)`);

let cursor = 0;                       // live source position, in FRAMES, ever-advancing
let carry = 0;
let stalled = false;                  // control: stop feeding clients (simulates a hung stream)
let refusing = false;                 // control: reject connections (simulates a dead station)
let nextId = 1;
const conns = [];                     // every connection ever, for the audit log

const t0 = Date.now();
const now = () => ((Date.now() - t0) / 1000).toFixed(2);

setInterval(() => {
  carry += FPS * TICK_MS / 1000;
  const n = Math.floor(carry);
  carry -= n;
  const from = cursor;
  cursor += n;
  if (stalled) return;
  for (const c of conns) {
    if (c.closedAt || c.res.writableEnded) continue;
    for (let i = from; i < cursor; i++) {
      const f = FRAMES[i % FRAMES.length];     // loop the tone; the cursor never rewinds
      c.res.write(f);
      c.bytes += f.length;
      c.frames++;
    }
  }
}, TICK_MS);

const server = https.createServer({
  key:  fs.readFileSync(path.join(DIR, 'key.pem')),
  cert: fs.readFileSync(path.join(DIR, 'cert.pem'))
}, (req, res) => {
  if (refusing) {
    console.log(`[${now()}] REFUSED ${req.url}`);
    res.writeHead(503); res.end('station down');
    return;
  }
  const c = {
    id: nextId++,
    url: req.url,
    openedAt: +now(),
    openedAtCursorSec: +(cursor / FPS).toFixed(2),
    closedAt: null,
    bytes: 0, frames: 0,
    res
  };
  conns.push(c);
  console.log(`[${now()}] OPEN  #${c.id}  live-cursor=${c.openedAtCursorSec}s  ${req.url}`);
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'close'
  });
  const close = () => {
    if (c.closedAt !== null) return;
    c.closedAt = +now();
    console.log(`[${now()}] CLOSE #${c.id}  after ${(c.closedAt - c.openedAt).toFixed(2)}s  ${c.bytes}B`);
  };
  req.on('close', close);
  res.on('close', close);
});
server.listen(8443, '127.0.0.1', () => console.log('fake stream on https://127.0.0.1:8443'));

// ---- control API (plain http, for the test driver) ----
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const on = u.searchParams.get('on') === '1';
  if (u.pathname === '/ctl/stall')   { stalled = on;  console.log(`[${now()}] CTL stall=${on}`); }
  if (u.pathname === '/ctl/refuse')  { refusing = on; console.log(`[${now()}] CTL refuse=${on}`); }
  if (u.pathname === '/ctl/mark')    { console.log(`[${now()}] --- ${u.searchParams.get('m')} ---`); }
  if (u.pathname === '/ctl/reset')   { conns.length = 0; nextId = 1; console.log(`[${now()}] CTL reset`); }
  res.writeHead(200, {'Content-Type':'application/json'});
  res.end(JSON.stringify({
    t: +now(),
    liveCursorSec: +(cursor / FPS).toFixed(2),
    stalled, refusing,
    open: conns.filter(c => !c.closedAt).length,
    total: conns.length,
    conns: conns.map(c => ({
      id: c.id, url: c.url, openedAt: c.openedAt, openedAtCursorSec: c.openedAtCursorSec,
      closedAt: c.closedAt, bytes: c.bytes, sec: +(c.frames / FPS).toFixed(2)
    }))
  }));
}).listen(8091, '127.0.0.1', () => console.log('control api on http://127.0.0.1:8091'));
