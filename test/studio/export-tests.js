'use strict';

/**
 * Studio export dialog — does clicking Download put a file on disk?
 *
 * Why this exists: the first export UI was plain `<a download>` links, and its
 * browser check fetched each link's URL with `fetch()` and saw 200. That skips
 * the browser's download path entirely, which is the one thing a station
 * manager uses. The live report was "the download starts but nothing is
 * downloaded", and nothing in the suite could have seen it (CLAUDE.md §3a.2:
 * an API that bypasses the thing tested).
 *
 * So every check here is a real mouse click through Input.dispatchMouseEvent,
 * and "downloaded" means a finished file in a download directory Chrome was
 * told to use — read back and parsed, not a status code.
 *
 * Section 4 is the self-test (§3a.4): an export the server refuses must show
 * its error in the dialog AND land no file. If the probe could not see a
 * missing file, sections 2–3 would prove nothing.
 *
 *   CDP_PORT=9225 node --experimental-websocket export-tests.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cdp = require('../live-stream/cdp.js');

const PORT = Number(process.env.CDP_PORT || 9225);
const BASE = process.env.BASE || 'http://localhost:8080';
const PASSWORD = process.env.STUDIO_PASSWORD || 'local-dev-password';

let failures = 0;
function ok(label, cond, detail) {
  if (!cond) failures++;
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
  if (!cond && detail !== undefined) console.log(`       ${detail}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-export-dl-'));
  const c = await cdp.connect(PORT);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });

  const ev = async (e) => (await c.send('Runtime.evaluate',
    { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  const size = (w) => c.send('Emulation.setDeviceMetricsOverride',
    { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 500 });
  const go = async () => {
    await c.send('Page.navigate', { url: BASE + '/studio' });
    await wait(1800);
  };
  // A real click at the element's centre, after scrolling it into view the way
  // a person would — not element.click(), which skips hit-testing.
  async function click(selector) {
    const r = JSON.parse(await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'null';
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      return JSON.stringify({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    })()`));
    if (!r) throw new Error('no element ' + selector);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    }
    await wait(250);
  }
  const files = () => fs.readdirSync(dir).filter((f) => !f.endsWith('.crdownload'));
  async function landed(pattern, before) {
    for (let i = 0; i < 40; i++) {
      const f = files().find((n) => pattern.test(n) && !before.includes(n));
      if (f && !fs.readdirSync(dir).some((n) => n.endsWith('.crdownload'))) return f;
      await wait(150);
    }
    return null;
  }
  const status = async () => JSON.parse(await ev(`JSON.stringify({
    text: document.getElementById('exportStatus').textContent,
    cls: document.getElementById('exportStatus').className })`));

  // Is the Download button on screen and actually hit-testable, with no
  // scrolling? Measured before any click() helper scrolls it into view — the
  // first dialog had it below the fold on a laptop-height window.
  const reachable = async () => JSON.parse(await ev(`(() => {
    const b = document.getElementById('exportGo').getBoundingClientRect();
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return JSON.stringify({ top: Math.round(b.top), bottom: Math.round(b.bottom), vh: innerHeight,
      hit: !!hit && (hit.id === 'exportGo' || !!hit.closest('#exportGo')) });
  })()`));

  // ---- 1. sign in, open the dialog from the header
  await size(1200);
  await go();
  if (await ev("!!document.getElementById('loginForm')")) {
    await ev(`(function(){
      document.getElementById('password').value = ${JSON.stringify(PASSWORD)};
      document.getElementById('loginForm').requestSubmit();
    })()`);
    await wait(1800);
    await go();
  }
  console.log('\n1. the Export button opens the dialog');
  ok('signed in', await ev("!!document.getElementById('exportOpen')"));
  ok('dialog starts closed', await ev("!document.getElementById('exportDialog').open"));
  await click('#exportOpen');
  await wait(800);
  const opened = JSON.parse(await ev(`JSON.stringify({
    open: document.getElementById('exportDialog').open,
    from: exportFrom.value, to: exportTo.value,
    pressed: [...document.querySelectorAll('#exportPresets [aria-pressed=true]')].map((b) => b.dataset.preset),
    go: !document.getElementById('exportGo').disabled })`));
  ok('clicking Export opens the dialog', opened.open);
  ok('dates are filled and one preset is chosen', !!opened.from && !!opened.to && opened.pressed.length === 1,
    JSON.stringify(opened));
  ok('Download is enabled', opened.go);
  const r1 = await reachable();
  ok('Download is on screen without scrolling (1200×900)', r1.hit && r1.bottom <= r1.vh, JSON.stringify(r1));

  // ---- 2. Download puts real files on disk
  console.log('\n2. Download saves a real file');
  let before = files();
  await click('#exportGo');
  const daily = await landed(/^[a-z0-9]+-listening-daily-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/, before);
  ok('Daily totals: a CSV lands in the download folder', !!daily, `files: ${files().join(', ') || 'none'}`);
  if (daily) {
    const buf = fs.readFileSync(path.join(dir, daily));
    ok('it starts with the UTF-8 BOM', buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
    ok('its header row is the daily columns', buf.toString('utf8').slice(1).startsWith('station,date_utc,page_views,'));
    const rows = buf.toString('utf8').trim().split('\r\n').length - 1;
    const span = JSON.parse(await ev(`JSON.stringify([exportFrom.value, exportTo.value])`));
    const days = Math.round((Date.parse(span[1]) - Date.parse(span[0])) / 86400000) + 1;
    ok('one row per day of the chosen span', rows === days, `${rows} rows for ${days} days`);
  }
  const s1 = await status();
  ok('the dialog says what was saved', s1.cls.includes('is-ok') && daily && s1.text.includes(daily), JSON.stringify(s1));

  before = files();
  await click('input[name=exportFile][value="listening:csv:shows"]');
  await click('#exportGo');
  const shows = await landed(/-listening-shows-.*\.csv$/, before);
  ok('Per show: choosing the card changes the file', !!shows && fs.readFileSync(path.join(dir, shows), 'utf8').slice(1).startsWith('station,show_key,show_title,'));

  before = files();
  await click('input[name=exportFile][value="listening:json"]');
  await click('#exportGo');
  const json = await landed(/-listening-.*\.json$/, before);
  let parsed = null;
  try { parsed = json && JSON.parse(fs.readFileSync(path.join(dir, json), 'utf8')); } catch (e) { parsed = null; }
  ok('Everything: a JSON file with all three tables lands', !!parsed && Array.isArray(parsed.daily) && Array.isArray(parsed.shows) && Array.isArray(parsed.reach));

  before = files();
  await click('#exportReadme');
  const readme = await landed(/-README\.txt$/, before);
  ok('the read-me link saves the column explanations', !!readme && /Personal data/.test(fs.readFileSync(path.join(dir, readme), 'utf8')));

  // ---- 2b. the other datasets: pick one, and its cards, dates and file follow
  console.log('\n2b. Archive and Coverage');
  await click('input[name=exportDataset][value="inventory"]');
  const invState = JSON.parse(await ev(`JSON.stringify({
    cards: [...document.querySelectorAll('.export-choices:not([hidden]) input[name=exportFile]')].map((i) => i.value),
    checked: document.querySelector('input[name=exportFile]:checked').value,
    datesOff: document.getElementById('exportDates').disabled,
    clock: document.getElementById('exportClock').textContent, min: exportFrom.min })`));
  ok('Archive shows its own cards and checks the first', invState.cards.join() === 'inventory:csv:episodes,inventory:csv:shows,inventory:json'
    && invState.checked === 'inventory:csv:episodes', JSON.stringify(invState));
  ok('its dates are air dates in the station timezone', !invState.datesOff && /air date in /.test(invState.clock), JSON.stringify(invState));
  await click('[data-preset=all]');
  before = files();
  await click('#exportGo');
  const episodes = await landed(/-archive-episodes-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/, before);
  const epText = episodes ? fs.readFileSync(path.join(dir, episodes), 'utf8') : '';
  ok('Episodes: a CSV of the archive lands', !!episodes && epText.slice(1).startsWith('station,show_key,show_title,episode_title,')
    && epText.trim().split('\r\n').length > 1, `files: ${files().join(', ')}`);

  await click('input[name=exportDataset][value="coverage"]');
  const covState = JSON.parse(await ev(`JSON.stringify({ datesOff: document.getElementById('exportDates').disabled,
    clock: document.getElementById('exportClock').textContent, go: document.getElementById('exportGo').disabled })`));
  ok('Coverage switches the dates off and says why', covState.datesOff && /snapshot/.test(covState.clock) && !covState.go, JSON.stringify(covState));
  before = files();
  await click('#exportGo');
  const coverage = await landed(/-coverage-shows-\d{4}-\d{2}-\d{2}\.csv$/, before);
  const covText = coverage ? fs.readFileSync(path.join(dir, coverage), 'utf8') : '';
  ok('Coverage: a CSV of every show lands', !!coverage && covText.slice(1).startsWith('station,show_key,show_title,has_feed,')
    && covText.trim().split('\r\n').length > 1, `files: ${files().join(', ')}`);

  ok('there is no Station profile choice on WBAI', await ev("!document.querySelector('input[name=exportDataset][value=profile]')"));

  await click('input[name=exportDataset][value="listening"]');
  const back = JSON.parse(await ev(`JSON.stringify({ checked: document.querySelector('input[name=exportFile]:checked').value,
    datesOff: document.getElementById('exportDates').disabled, go: document.getElementById('exportGo').disabled })`));
  ok('back on Listening, its cards and dates return', back.checked.startsWith('listening:') && !back.datesOff && !back.go, JSON.stringify(back));

  // ---- 3. presets move the dates
  console.log('\n3. presets and dates');
  await click('[data-preset=all]');
  const all = JSON.parse(await ev(`JSON.stringify({ from: exportFrom.value, min: exportFrom.min, to: exportTo.value, max: exportTo.max })`));
  ok('All time spans the oldest data to today', all.from === all.min && all.to === all.max, JSON.stringify(all));
  await ev(`(() => { const f = exportFrom.value; exportFrom.value = exportTo.value; exportTo.value = f;
    exportTo.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const bad = JSON.parse(await ev(`JSON.stringify({ go: document.getElementById('exportGo').disabled,
    note: document.getElementById('exportSpanNote').className })`));
  ok('a reversed span disables Download and says why',
    all.from === all.to ? true : (bad.go && bad.note.includes('is-bad')), JSON.stringify(bad));

  // ---- 4. self-test: a refused export is visible and lands nothing
  console.log('\n4. self-test — a refused export must be seen, and must land no file');
  await click('[data-preset=all]');
  // Loosen only the client's bound, so the request reaches the server and is
  // refused there (the span starts before any data exists).
  await ev(`(() => { exportFrom.min = '2000-01-01'; exportFrom.value = '2000-01-01';
    exportFrom.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  before = files();
  await click('#exportGo');
  await wait(1500);
  const s4 = await status();
  ok('the dialog shows the refusal with its HTTP status', s4.cls.includes('is-bad') && /HTTP 400/.test(s4.text), JSON.stringify(s4));
  ok('and no file landed', files().length === before.length, `files now: ${files().join(', ')}`);

  // ---- 4b. Backup & restore — download a backup, then preview restoring that
  // same file. Never clicks Restore: this section must be safe to run against
  // a live station.
  console.log('\n4b. backup, and a restore preview that writes nothing');
  await click('#tabBackup');
  const panes = JSON.parse(await ev(`JSON.stringify({ reports: document.getElementById('paneReports').hidden,
    backup: document.getElementById('paneBackup').hidden, selected: document.getElementById('tabBackup').getAttribute('aria-selected') })`));
  ok('the Backup & restore tab shows its pane and hides Reports', panes.reports && !panes.backup && panes.selected === 'true', JSON.stringify(panes));
  before = files();
  await click('#backupDownload');
  const backupName = await landed(/^[a-z0-9]+-backup-\d{4}-\d{2}-\d{2}\.json$/, before);
  let backup = null;
  try { backup = backupName && JSON.parse(fs.readFileSync(path.join(dir, backupName), 'utf8')); } catch (e) { backup = null; }
  ok('Download backup saves a backup file, with the archive\'s episodes', !!backup && backup.format === 'pacifica-archive-backup'
    && Object.keys(backup.stats).length > 0 && !!backup.feeds && Object.keys(backup.feeds).length > 0,
    `files: ${files().join(', ')}`);
  if (backupName) {
    const doc = await c.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#restoreFile' });
    // A long file name on purpose: a name that does not wrap pushed past the
    // dialog edge on a phone, and a short one hid it.
    const longName = path.join(dir, 'a-very-long-backup-file-name-somebody-renamed-wbai-2026.json');
    fs.copyFileSync(path.join(dir, backupName), longName);
    await c.send('DOM.setFileInputFiles', { nodeId, files: [longName] });
    let shown = null;
    for (let i = 0; i < 30 && !shown; i++) {
      await wait(150);
      shown = JSON.parse(await ev(`JSON.stringify(document.getElementById('restorePreview').hidden ? null : {
        rows: [...document.querySelectorAll('#restorePlan tr')].map((tr) => tr.querySelector('.plan-badge').textContent),
        apply: document.getElementById('restoreApply').textContent, disabled: document.getElementById('restoreApply').disabled,
        name: document.getElementById('restoreFileName').textContent,
        feeds: document.getElementById('restoreFeedsBadge').textContent })`));
    }
    ok('choosing the file shows a month-by-month preview', !!shown && shown.rows.length === Object.keys(backup.stats).length,
      JSON.stringify(shown) + ' ' + JSON.stringify(await status()));
    ok('restoring this server\'s own fresh backup would add nothing', !!shown && !shown.rows.includes('New')
      && shown.feeds === 'Already the same', JSON.stringify(shown));

    // The layout is judged on a preview with every kind of card and the longest
    // text: a copy of that backup with an older month added and this month's
    // figures changed, re-signed with the app's own checksum. Still only a
    // preview — Restore is never clicked. (The first fit check used the plain
    // backup, whose short "No change." text hid text overflowing on a phone.)
    const crafted = JSON.parse(JSON.stringify(backup));
    const cur = Object.keys(crafted.stats).sort().pop();
    const d0 = Object.keys(crafted.stats[cur].days)[0];
    if (d0) crafted.stats[cur].days[d0].plays += 40;
    crafted.stats['2001-01'] = { station: crafted.station, month: '2001-01', days: { '2001-01-15': {
      pageviews: 123456, plays: 65432, live: 1, searches: 0, shares: 0, listenSeconds: 987654, liveSeconds: 12345,
      byShow: {}, secondsByShow: {}, byZone: {} } } };
    // And an episode this server never held, on a show it does, so the
    // episodes line has its longest text too.
    const firstShow = Object.keys(crafted.feeds).find((k) => crafted.feeds[k].items.length);
    if (firstShow) crafted.feeds[firstShow].items.push(Object.assign({}, crafted.feeds[firstShow].items[0],
      { mp3: 'https://archive2.wbai.org/mp3/test-only-never-restored-2001-01-15.mp3', dt: 979560000 }));
    const { monthChecksum } = require('../../lib/export/backup');
    for (const m of Object.keys(crafted.stats)) crafted.checksums[m] = monthChecksum(crafted.stats[m]);
    crafted.feedsChecksum = monthChecksum(crafted.feeds);
    const craftedFile = path.join(dir, 'a-very-long-backup-file-name-somebody-renamed-with-changes-2026.json');
    fs.writeFileSync(craftedFile, JSON.stringify(crafted));
    await c.send('DOM.setFileInputFiles', { nodeId, files: [craftedFile] });
    let variety = null;
    for (let i = 0; i < 30; i++) {
      await wait(150);
      variety = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#restorePlan .plan-badge')].map((b) => b.textContent))`));
      if (variety.includes('New')) break;
    }
    ok('a changed backup previews New and Replaced months, and Restore names the count',
      variety.includes('New') && (variety.includes('Replaced') || !d0)
        && /^Restore \d+ months? and 1 episode$/.test(await ev("document.getElementById('restoreApply').textContent"))
        && await ev("document.getElementById('restoreFeedsBadge').textContent === 'Added'"), JSON.stringify(variety));
    // Every element of the pane inside the dialog's box, and nothing clipped by a
    // scroll container: the table version hid its "What happens" column on a laptop.
    for (const w of [1200, 390]) {
      await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 500 });
      await wait(400);
      const fitB = JSON.parse(await ev(`(() => {
        const d = document.getElementById('exportDialog'), b = d.getBoundingClientRect();
        const out = [...d.querySelectorAll('#paneBackup *')].filter((el) => {
          const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > b.right + 1 || r.left < b.left - 1);
        }).map((el) => el.tagName.toLowerCase() + '.' + el.className);
        // Content wider than its own box, in ANY overflow mode: text that will not
        // wrap spills out of a visible-overflow cell without growing the cell's
        // rect, so element rects alone passed a layout whose text overlapped.
        const clipped = [...d.querySelectorAll('#paneBackup *')].filter((el) => el.tagName !== 'INPUT'
          && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1).map((el) => el.tagName.toLowerCase() + '.' + el.className);
        // And each rendered line of text against the element that holds it.
        const walker = document.createTreeWalker(d.querySelector('#paneBackup'), NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent.trim() || !n.parentElement.getClientRects().length) continue;
          const box = n.parentElement.getBoundingClientRect(), range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) {
            if (r.width && (r.right > box.right + 1 || r.left < box.left - 1)) {
              clipped.push('text "' + n.textContent.trim().slice(0, 30) + '"'); break;
            }
          }
        }
        const whatHappens = [...document.querySelectorAll('#restorePlan .plan-badge')].every((x) => {
          const r = x.getBoundingClientRect(); return r.width > 0 && r.right <= b.right;
        });
        return JSON.stringify({ out: out.slice(0, 3), clipped: clipped.slice(0, 3), whatHappens, sideways: d.scrollWidth > d.clientWidth + 1 });
      })()`));
      ok(`${w}px — the restore preview fits the dialog, "What happens" visible`,
        fitB.out.length === 0 && fitB.clipped.length === 0 && fitB.whatHappens && !fitB.sideways, JSON.stringify(fitB));
    }
    await size(1200);
  }
  await click('#tabReports');

  // ---- 5. closing, and the phone layout
  console.log('\n5. closing and small screens');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait(300);
  ok('Esc closes the dialog', await ev("!document.getElementById('exportDialog').open"));
  ok('focus returns to the Export button', await ev("document.activeElement === document.getElementById('exportOpen') || document.activeElement === document.body"));

  for (const w of [390, 360]) {
    await size(w);
    await go();
    await click('#exportOpen');
    await wait(700);
    const fit = JSON.parse(await ev(`(() => {
      const d = document.getElementById('exportDialog'), b = d.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const out = [...d.querySelectorAll('*')].filter((el) => {
        const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > b.right + 1 || r.left < b.left - 1);
      }).map((el) => el.tagName.toLowerCase() + '.' + el.className);
      return JSON.stringify({ open: d.open, left: b.left, right: b.right, vw, sideways: d.scrollWidth > d.clientWidth + 1, out: out.slice(0, 3) });
    })()`));
    const rw = await reachable();
    ok(`${w}px — Download is on screen without scrolling`, rw.hit && rw.bottom <= rw.vh, JSON.stringify(rw));
    ok(`${w}px — dialog is inside the screen`, fit.open && fit.left >= 0 && fit.right <= fit.vw, JSON.stringify(fit));
    ok(`${w}px — nothing inside it is cut off or scrolls sideways`, !fit.sideways && fit.out.length === 0, JSON.stringify(fit.out));
  }

  // ---- 6. the printable report: opened from the dialog, printed to PDF
  console.log('\n6. printable report');
  await size(1200);
  await go();
  await click('#exportOpen');
  await wait(800);
  await click('input[name=exportDataset][value="report"]');
  const repUi = JSON.parse(await ev(`JSON.stringify({ go: document.getElementById('exportGo').textContent,
    readmeHidden: document.getElementById('exportReadmeRow').hidden, clock: document.getElementById('exportClock').textContent,
    datesOff: document.getElementById('exportDates').disabled })`));
  ok('Printable report: the button says Open report, no read-me, both clocks explained',
    repUi.go === 'Open report' && repUi.readmeHidden && /UTC days/.test(repUi.clock) && /air dates in/.test(repUi.clock) && !repUi.datesOff,
    JSON.stringify(repUi));
  const targetsBefore = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).map((t) => t.id);
  await click('#exportGo');
  let reportTab = null;
  for (let i = 0; i < 30 && !reportTab; i++) {
    await wait(150);
    reportTab = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
      .find((t) => !targetsBefore.includes(t.id) && /\/studio\/report\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/.test(t.url));
  }
  ok('Open report opens the report in a new tab', !!reportTab, JSON.stringify(await status()));
  if (reportTab) await fetch(`http://127.0.0.1:${PORT}/json/close/${reportTab.id}`);

  await c.send('Page.navigate', { url: BASE + '/studio/report' });
  await wait(1500);
  const page = JSON.parse(await ev(`JSON.stringify({ h1: (document.querySelector('h1') || {}).textContent || '',
    sections: [...document.querySelectorAll('.section h2')].map((h) => h.textContent),
    print: !!document.getElementById('printReport'),
    css: [...document.styleSheets].some((s) => /report\.css/.test(s.href || '') && s.cssRules.length > 10) })`));
  ok('the report renders with its stylesheet', /report/.test(page.h1) && page.css && page.print
    && page.sections.includes('Listening at a glance') && page.sections.includes('About these figures'), JSON.stringify(page));
  await c.send('Emulation.setEmulatedMedia', { media: 'print' });
  await wait(300);
  const printed = JSON.parse(await ev(`(() => {
    const vw = document.documentElement.clientWidth;
    const out = [...document.querySelectorAll('body *')].filter((el) => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1;
    }).map((el) => el.tagName.toLowerCase() + '.' + el.className);
    return JSON.stringify({ toolbar: getComputedStyle(document.querySelector('.toolbar')).display, out: out.slice(0, 3) });
  })()`));
  ok('in print, the toolbar is hidden and nothing runs off the page', printed.toolbar === 'none' && printed.out.length === 0, JSON.stringify(printed));
  const pdf = await c.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  const pdfBytes = Buffer.from(pdf.data, 'base64');
  ok('Print → PDF produces a PDF', pdfBytes.subarray(0, 5).toString() === '%PDF-' && pdfBytes.length > 5000, `${pdfBytes.length} bytes`);
  await c.send('Emulation.setEmulatedMedia', { media: '' });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : '\nOK — all export checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
