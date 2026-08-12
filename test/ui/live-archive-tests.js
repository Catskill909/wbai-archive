// Live Player -> show/archive navigation contract. Now-playing is intercepted so
// current and next carry stable IDs chosen from the playable local archive; no
// audio is started in this suite.
const { connect, sleep } = require('../live-stream/cdp.js');
const PORT = Number(process.env.CDP_PORT) || 9224;
const BASE = process.env.BASE || 'http://localhost:8080';

let pass = 0, fail = 0;
function check(name, condition, detail) {
  (condition ? pass++ : fail++);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : '  -> ' + JSON.stringify(detail)}`);
}

function groupArchive(rows) {
  const groups = {};
  for (const row of rows.filter(r => r.mp3 && r.sho)) {
    (groups[String(row.sho).trim().toLowerCase()] ||= []).push(row);
  }
  return Object.values(groups)
    .map(g => g.sort((a, b) => (b.dt || 0) - (a.dt || 0)))
    .sort((a, b) => b.length - a.length);
}

(async () => {
  const archive = await (await fetch(BASE + '/api/archive')).json();
  const groups = groupArchive(archive.shows || []);
  if (groups.length < 3) throw new Error('need three playable show groups');
  const [a, b, c] = groups;

  let now = {
    current: { name:a[0].title, dj:a[0].host || '', altid:a[0].sho, start:'1:00 PM', end:'2:00 PM', photo:a[0].photo || '' },
    next: { name:b[0].title, altid:b[0].sho, start:'2:00 PM', end:'3:00 PM' }
  };

  const p = await connect(PORT);
  await p.send('Page.enable');
  await p.send('Runtime.enable');
  await p.send('Fetch.enable', { patterns:[{ urlPattern:'*/api/nowplaying*' }] });
  const pageErrors = [];
  p.on(async message => {
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.text + ' ' +
        ((message.params.exceptionDetails.exception || {}).description || ''));
    }
    if (message.method !== 'Fetch.requestPaused') return;
    await p.send('Fetch.fulfillRequest', {
      requestId:message.params.requestId,
      responseCode:200,
      responseHeaders:[{ name:'Content-Type', value:'application/json' }],
      body:Buffer.from(JSON.stringify({ updated:Date.now(), current:now.current, next:now.next })).toString('base64')
    });
  });

  async function load() {
    await p.send('Page.navigate', { url:BASE + '/' });
    await sleep(2200);
  }
  async function openLive() { await p.click('#onAirBtn'); await sleep(450); }
  const liveRoutes = () => p.eval(`
    var cur = document.getElementById('lpArchive');
    var next = document.getElementById('lpUpNext');
    return {
      currentHidden:cur.hidden,
      currentId:cur.dataset.altid || '',
      currentCount:+document.getElementById('lpArchiveCount').textContent || 0,
      currentAria:cur.getAttribute('aria-label') || '',
      nextHidden:next.hidden,
      nextDisabled:next.disabled,
      nextId:next.dataset.altid || '',
      nextAria:next.getAttribute('aria-label') || '',
      nextArrow:getComputedStyle(next.querySelector('.lp-upnext-arrow')).display,
      infoPromise:document.getElementById('lpInfoBtn').getAttribute('aria-label'),
      archiveSrc:document.getElementById('mainAudio').getAttribute('src') || '',
      liveElements:Array.from(document.querySelectorAll('audio')).filter(e => e.id !== 'mainAudio').length
    };
  `);
  const sheetState = () => p.eval(`
    var sheet=document.getElementById('showSheet');
    return {
      open:sheet.classList.contains('show'),
      archive:sheet.classList.contains('archive-view'),
      title:(sheet.querySelector('.sheet-archive-title') || document.getElementById('sheetTitle') || {}).textContent || '',
      rows:sheet.querySelectorAll('.sheet-episode').length,
      liveOpen:document.getElementById('livePlayer').classList.contains('show'),
      archiveSrc:document.getElementById('mainAudio').getAttribute('src') || '',
      liveElements:Array.from(document.querySelectorAll('audio')).filter(e => e.id !== 'mainAudio').length
    };
  `);

  console.log('\n1. exact current and next routes');
  await load();
  await openLive();
  let s = await liveRoutes();
  check('current Past episodes is offered for an exact playable ID',
    !s.currentHidden && s.currentId === a[0].sho, s);
  check('current route reports the existing grouped episode count', s.currentCount === a.length,
    [s.currentCount, a.length]);
  check('Up next is one enabled show-information target',
    !s.nextHidden && !s.nextDisabled && s.nextId === b[0].sho && /show information/i.test(s.nextAria), s);
  check('the artwork keeps its Show info promise', /about this show/i.test(s.infoPromise), s.infoPromise);
  check('navigation starts no audio', !s.archiveSrc && s.liveElements === 0, s);

  await p.click('#lpArchive');
  await sleep(500);
  s = await sheetState();
  check('current Past episodes lands directly in the archive route',
    s.open && s.archive && s.title === a[0].title && s.rows === a.length, s);
  check('current archive navigation leaves both audio sources untouched', !s.archiveSrc && s.liveElements === 0, s);
  await p.click('#sheetClose');
  await sleep(650);
  await openLive();
  await p.click('#lpUpNext');
  await sleep(500);
  s = await sheetState();
  check('Up next lands on that show profile, not directly in Past episodes',
    s.open && !s.archive && s.title === b[0].title, s);
  check('next-show navigation also starts no audio', !s.archiveSrc && s.liveElements === 0, s);

  console.log('\n2. IDs fail quietly; titles never manufacture a route');
  now = {
    current:{ name:a[0].title, dj:'', altid:'not_a_real_archive_slug', start:'', end:'' },
    next:{ name:b[0].title, altid:'also_not_real', start:'2:00 PM', end:'3:00 PM' }
  };
  await load();
  await openLive();
  s = await liveRoutes();
  check('a familiar current title with the wrong ID gets no archive route', s.currentHidden, s);
  check('a familiar next title with the wrong ID stays plain and noninteractive',
    !s.nextHidden && s.nextDisabled && !s.nextId && s.nextArrow === 'none', s);

  console.log('\n3. rollover retargets Live Player without hijacking browsing');
  now = {
    current:{ name:a[0].title, dj:'', altid:a[0].sho, start:'1:00 PM', end:'2:00 PM' },
    next:{ name:b[0].title, altid:b[0].sho, start:'2:00 PM', end:'3:00 PM' }
  };
  await load();
  await openLive();
  await p.click('#lpArchive');
  await sleep(500);
  now = {
    current:{ name:c[0].title, dj:'', altid:c[0].sho, start:'2:00 PM', end:'3:00 PM' },
    next:{ name:a[0].title, altid:a[0].sho, start:'3:00 PM', end:'4:00 PM' }
  };
  await sleep(16500);
  s = await sheetState();
  check('an open archive remains on the show the listener chose',
    s.open && s.archive && s.title === a[0].title && !s.liveOpen, s);
  const retargeted = await p.eval(`return {
    current:document.getElementById('lpArchive').dataset.altid || '',
    next:document.getElementById('lpUpNext').dataset.altid || ''
  };`);
  check('the hidden Live Player routes retarget to the new current and next IDs',
    retargeted.current === c[0].sho && retargeted.next === a[0].sho, retargeted);
  check('rollover still changes no audio state', !s.archiveSrc && s.liveElements === 0, s);
  check('no uncaught page exceptions', pageErrors.length === 0, pageErrors);

  console.log(`\n${pass} passed, ${fail} failed`);
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
