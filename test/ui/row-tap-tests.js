// Row tap-target suite: the whole list row, everything left of the play
// control, opens the info sheet.
//
// Why this exists: the row is ~100px tall on a phone, and for a long time the
// only live targets in it were a single line of title text and a 15px "More".
// Everything else — the date line, the retention pill, the space past the end
// of the title — looked tappable and did nothing, so taps just missed.
//
// House rule (CLAUDE.md §3a): assert the EFFECT. Every check below dispatches a
// TRUSTED mouse event at a real coordinate inside a real row and then asks
// whether the sheet opened. Nothing here reads a handler, a class or a style —
// those were all present the whole time the taps were missing.
const { connect, sleep } = require('../live-stream/cdp.js');
const PORT = Number(process.env.CDP_PORT) || 9224;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

(async () => {
  const p = await connect(PORT);
  await p.send('Page.enable');

  // Phone metrics: this is the layout the misses were reported on, and it is
  // also the one where the row stacks into three bands (title / date / pill),
  // so the dead zones are largest.
  await p.send('Emulation.setDeviceMetricsOverride',
    { width: 402, height: 874, deviceScaleFactor: 2, mobile: true });
  await p.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await p.send('Page.navigate', { url: 'http://localhost:8080/' });
  await sleep(2500);

  // The gallery is the default view for a first-time visitor; this suite is
  // about list rows, so switch and prove the switch took.
  await p.click('.view-btn[data-view="list"]');
  await sleep(600);
  const rows = await p.eval(`return document.querySelectorAll('.row.body').length;`);
  ok('list view rendered rows to tap', rows > 2, 'rows=' + rows);
  if (rows < 3) { console.log(`\n${pass} passed, ${fail} failed`); p.close(); process.exit(1); }

  const sheetOpen = () => p.eval(`
    var s = document.querySelector('.sheet');
    return !!(s && s.classList.contains('show'));`);
  const closeSheet = async () => {
    await p.eval(`
      var s = document.querySelector('.sheet');
      if (s && s.classList.contains('show')) document.querySelector('.sheet-close').click();
      return 1;`);
    await sleep(300);
  };

  // Tap a point inside row #1, expressed as a fraction of its own box so the
  // probe follows the layout instead of hard-coding pixels. Returns what was
  // actually under the finger, which is the only way to know the probe tested
  // what it claims to.
  async function tapRow(fx, fy) {
    const pt = await p.eval(`
      var row = document.querySelectorAll('.row.body')[1];
      row.scrollIntoView({block:'center'});
      var r = row.getBoundingClientRect();
      var x = r.left + r.width*${fx}, y = r.top + r.height*${fy};
      var t = document.elementFromPoint(x, y);
      return { x: x, y: y, inRow: !!(t && row.contains(t)),
               on: t ? (t.tagName + '.' + (t.className || '')).trim().slice(0, 44) : 'none' };`);
    if (!pt.inRow) return { missed: true, on: pt.on };
    for (const type of ['mousePressed', 'mouseReleased']) {
      await p.send('Input.dispatchMouseEvent', {
        type, x: pt.x, y: pt.y, button: 'left', clickCount: 1,
        buttons: type === 'mousePressed' ? 1 : 0
      });
    }
    await sleep(400);
    return { missed: false, on: pt.on, opened: await sheetOpen() };
  }

  console.log('\n1. every dead zone left of the play control opens the sheet');
  const PROBES = [
    ['blank space past the title', 0.80, 0.18],
    ['the aired date line',        0.30, 0.55],
    ['the retention pill',         0.15, 0.85],
    ['the band beside the pill',   0.80, 0.85],
    ['the artwork',                0.10, 0.18]
  ];
  for (const [name, fx, fy] of PROBES) {
    await closeSheet();
    const r = await tapRow(fx, fy);
    if (r.missed) { ok('tap on ' + name, false, 'probe fell outside the row (' + r.on + ')'); continue; }
    ok('tap on ' + name + ' opens the sheet', r.opened === true, 'landed on ' + r.on);
  }

  console.log('\n2. the play column is still the play column');
  await closeSheet();
  const pb = await p.eval(`
    var row = document.querySelectorAll('.row.body')[1];
    row.scrollIntoView({block:'center'});
    var r = row.querySelector('.play-btn').getBoundingClientRect();
    return { x: r.left + r.width/2, y: r.top + r.height/2 };`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await p.send('Input.dispatchMouseEvent', {
      type, x: pb.x, y: pb.y, button: 'left', clickCount: 1,
      buttons: type === 'mousePressed' ? 1 : 0
    });
  }
  await sleep(600);
  ok('tapping play does NOT open the sheet', (await sheetOpen()) === false);

  console.log('\n3. SELF-TEST — the probe can still see an open sheet');
  // Section 1 is a wall of "the sheet opened" passes. If the probe ever goes
  // blind, they all keep passing while the app does nothing. Force the state it
  // is supposed to detect and require it to notice.
  await closeSheet();
  ok('sheet reads closed when it is closed', (await sheetOpen()) === false);
  await p.eval(`document.querySelector('.sheet').classList.add('show'); return 1;`);
  ok('sheet reads open when it is open', (await sheetOpen()) === true);
  await closeSheet();

  console.log(`\n${pass} passed, ${fail} failed`);
  p.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
