(function(){
  var CATS = [
    {key:'news', label:'News', color:'#e14a2e'},
    {key:'public-affairs', label:'Public Affairs', color:'#e0a63a'},
    {key:'arts', label:'Arts & Culture', color:'#4fb6ac'},
    {key:'health', label:'Health', color:'#6fae7c'},
    {key:'music', label:'Music', color:'#9b7fd1'},
    {key:'science', label:'Science & Tech', color:'#4f9fd1'},
    {key:'special', label:'Special Programming', color:'#d17fb0'}
  ];
  var CAT_BY_KEY = {}; CATS.forEach(function(c){ CAT_BY_KEY[c.key]=c; });

  var MP3_BASE = 'https://archive2.wbai.org/mp3/';
  var RSS_BASE = 'https://archive2.wbai.org/getrss.php?id=';
  var LIVE_URL = 'https://streaming.wbai.org/wbai_verizon';
  var ARCHIVE_PAGE = 'https://wbai.org/archive/';

  // Dev switch for the live-failure alert, so it can be seen without waiting for
  // the station to actually fall over. `?livefail=1` aims the player at a URL
  // that cannot play (the real error path, end to end); `?livefail=down` also
  // makes the reachability probe report the stream host as unreachable. Inert
  // unless the query string is present.
  var LIVE_FAIL = (location.search.match(/[?&]livefail=([\w-]+)/) || [])[1] || '';
  if(LIVE_FAIL) LIVE_URL = '/assets/livefail-not-a-stream.mp3';

  // ---------------- Feature flags ----------------
  // SHOW_RSS — off by policy, not by accident. Access to episodes stays inside
  // the web app and the native apps: no feeds, no file handoffs. (Upstream's
  // getrss.php also returns a zero-byte body for every show, so nothing that
  // worked was removed — but the policy is the operative reason and holds
  // regardless.) Nothing was deleted: the server still parses `hasRSS`, and the
  // icon, the styles and both call sites are all still here, so flipping this
  // to true restores them. Read docs/DEVELOPMENT.md § Feature flags first.
  var SHOW_RSS = false;

  // Single gate for both surfaces, so re-enabling can never turn on one and
  // miss the other.
  function showRss(r){ return SHOW_RSS && !!r.hasRSS; }


  var rows = [];

  var latestDt = 0;

  // Gallery is the default: the artwork is the fastest way to recognise a show,
  // and first-time visitors arrive with no saved preference. Anyone who picks
  // list keeps it — only an unset/garbage value falls back to 'grid'.
  var savedView = 'grid';
  try {
    var storedView = localStorage.getItem('wbai-view');
    if(storedView==='list' || storedView==='grid') savedView = storedView;
  } catch(e){}
  // sortKey 'archive' = the order archive2 publishes them in (see the sort
  // comparator). It is the default so this listing and archive2's read alike on
  // load; clicking any column header switches to a real sort and there is no way
  // back to it short of a reload, which is fine — it is a starting view, not a
  // column.
  var state = { query:'', cat:'all', sortKey:'archive', sortDir:'desc', view:savedView };

  // ---------------- URL state ----------------
  // Search, category and the open sheet are reflected in the query string so a
  // view can be linked, a manifest shortcut can land on a category, and the
  // system back button closes the sheet instead of leaving the app — which in
  // standalone (installed) mode is the only back affordance there is.
  //
  // The view is *not* in the URL: it's a per-device preference in localStorage,
  // and putting it in a shared link would impose the sharer's layout.
  function param(name){
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
    try { return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; }
    catch(e){ return ''; }
  }
  // Only the shape of the state goes in, never a value we didn't put there:
  // `cat` is checked against our own table rather than trusted from the URL.
  function urlFor(sheetId){
    var q = [];
    if(state.cat !== 'all' && CAT_BY_KEY[state.cat]) q.push('cat=' + encodeURIComponent(state.cat));
    if(state.query) q.push('q=' + encodeURIComponent(state.query));
    if(sheetId) q.push('show=' + encodeURIComponent(sheetId));
    return location.pathname + (q.length ? '?' + q.join('&') : '');
  }
  var canHistory = !!(window.history && history.replaceState);
  // Filters never add a history entry — only the sheet does, so that one press
  // of Back means "close the sheet", not "undo six keystrokes of searching".
  function syncUrl(){
    if(!canHistory) return;
    var open = sheetRowId || null;
    try { history.replaceState(open ? {sheetId:open} : null, '', urlFor(open)); } catch(e){}
  }

  function retentionClass(d){
    if(d<=3) return 'danger';
    if(d<=14) return 'warn';
    return 'good';
  }
  function retentionLabel(d){
    if(d<=0) return 'Last day';
    if(d===1) return '1 day left';
    return d+' days left';
  }
  function splitDateText(txt){
    var m = txt.match(/^(.*\d{4})\s+(\d{1,2}:\d{2}\s*[ap]m)$/i);
    return m ? {date:m[1], time:m[2]} : {date:txt, time:''};
  }

  // ---- Category dropdown ----
  // A custom listbox (not a native <select>) so each option can carry its
  // colour swatch and match the app's styling. Keeps the same `state.cat`
  // contract the chips used, so URL sync and filtering are unchanged.
  var catSelect = document.getElementById('catSelect');
  var catTrigger = document.getElementById('catTrigger');
  var catTriggerIcon = document.getElementById('catTriggerIcon');
  var catTriggerValue = document.getElementById('catTriggerValue');
  var catMenu = document.getElementById('catMenu');

  // Per-category glyphs. Colour swatches carried no meaning for listeners, so
  // each category is signalled with a recognisable line icon instead. Keys match
  // CATS; 'all' uses a funnel to read as "the filter control".
  var CAT_ICONS = {
    all:'<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
    news:'<rect x="4" y="5" width="13" height="14" rx="1.5"/><path d="M17 9h3v8a2 2 0 01-2 2h-1"/><path d="M7 9h7M7 12.5h7M7 16h4"/>',
    'public-affairs':'<path d="M3 21h18"/><path d="M5 21V10m4 11V10m6 11V10m4 11V10"/><path d="M12 3l8 5H4z"/>',
    arts:'<path d="M4 20c1.6 0 3-1.1 3-3 0-1.1-.9-2-2-2s-2 .9-2 2c0 1-.4 2-1 2.6.6.3 1.3.4 2 .4z"/><path d="M6.5 15.5l9-9a2 2 0 013 3l-9 9"/>',
    health:'<path d="M12 20s-7-4.4-7-9.6A3.6 3.6 0 0112 7a3.6 3.6 0 017 3.4C19 15.6 12 20 12 20z"/>',
    music:'<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="2.6"/><circle cx="16" cy="16" r="2.6"/>',
    science:'<path d="M9 3h6M10 3v5.5l-4.6 8A2 2 0 007.2 20h9.6a2 2 0 001.8-3.5L14 8.5V3"/><path d="M7.5 14h9"/>',
    special:'<path d="M12 3l2.3 5.8L20 10l-4.6 3.9L17 20l-5-3.3L7 20l1.6-6.1L3 10l5.7-1.2z"/>'
  };
  function catIcon(key){
    return '<svg class="cat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '+
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(CAT_ICONS[key]||'')+'</svg>';
  }

  function catOption(key, label){
    var sel = state.cat === key;
    return '<button class="cat-option" type="button" role="option" data-cat="'+key+'" aria-selected="'+sel+'">'+
      catIcon(key)+
      '<span class="cat-option-label">'+label+'</span>'+
      '<svg class="cat-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>'+
      '</button>';
  }
  function renderCatMenu(){
    var html = catOption('all', 'All shows');
    CATS.forEach(function(c){ html += catOption(c.key, c.label); });
    catMenu.innerHTML = html;
  }
  function renderCatTrigger(){
    var c = CAT_BY_KEY[state.cat];
    catTriggerIcon.innerHTML = catIcon(c ? c.key : 'all');
    catTriggerValue.textContent = c ? c.label : 'All shows';
    catTrigger.classList.toggle('is-filtered', state.cat !== 'all');
  }
  function renderCat(){ renderCatMenu(); renderCatTrigger(); }

  function catOptionEls(){ return Array.prototype.slice.call(catMenu.querySelectorAll('.cat-option')); }
  function focusCatOption(i){
    var els = catOptionEls();
    if(!els.length) return;
    i = (i + els.length) % els.length;
    els[i].focus();
  }
  function openCatMenu(){
    renderCatMenu();
    catMenu.hidden = false;
    catSelect.classList.add('open');
    catTrigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDocClickCat, true);
    document.addEventListener('keydown', onCatKeydown);
    // Land focus on the current choice so the arrow keys have a starting point.
    var sel = catMenu.querySelector('.cat-option[aria-selected="true"]');
    (sel || catMenu.querySelector('.cat-option')).focus();
  }
  function closeCatMenu(){
    catMenu.hidden = true;
    catSelect.classList.remove('open');
    catTrigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDocClickCat, true);
    document.removeEventListener('keydown', onCatKeydown);
  }
  function onDocClickCat(e){ if(!catSelect.contains(e.target)) closeCatMenu(); }
  function onCatKeydown(e){
    if(e.key === 'Escape'){ closeCatMenu(); catTrigger.focus(); return; }
    var els = catOptionEls();
    var idx = els.indexOf(document.activeElement);
    if(e.key === 'ArrowDown'){ e.preventDefault(); focusCatOption(idx < 0 ? 0 : idx + 1); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); focusCatOption(idx < 0 ? els.length - 1 : idx - 1); }
    else if(e.key === 'Home'){ e.preventDefault(); focusCatOption(0); }
    else if(e.key === 'End'){ e.preventDefault(); focusCatOption(els.length - 1); }
  }

  // ---------------- Send the list back to its first row ----------------
  // Changing the filter rebuilds the list underneath you, but the browser keeps
  // your scroll offset. Forty rows deep in Music, switch to News, and you land
  // in the middle of a different list — or, because render() also resets paging
  // to the first 40, in the empty space past the end of it.
  //
  // NOT window.scrollTo(0, 0): that drags the hero back into view too, so every
  // filter change would cost a swipe to get back to the results. The target is
  // the exact offset at which .controls-row reaches its sticky position, so the
  // search + filter bar does not appear to move at all and only the rows below
  // it reset.
  //
  // ⚠️ The obvious way to find that offset — `controlsRow.offsetTop - 57` — is
  // WRONG, and wrong in the silent direction. offsetTop reports the *used*
  // position, which for a stuck sticky element tracks the scroll: measured here
  // at 245 while at rest and 3057 after scrolling to 3000. The subtraction then
  // yields the offset you are already at, and the whole function becomes a
  // no-op precisely when it is needed. So the offset is derived from .hero,
  // which is static and therefore honest, plus its own height — .controls-row
  // is its next sibling in <main> with no margin between them.
  function listTopOffset(){
    var row = document.querySelector('.controls-row');
    var hero = document.querySelector('.hero');
    if(!row || !hero) return 0;
    var stickTop = parseFloat(getComputedStyle(row).top) || 0;
    var heroTop = hero.getBoundingClientRect().top + window.scrollY;
    return Math.max(0, heroTop + hero.offsetHeight - stickTop);
  }
  // Only ever scrolls UP. Someone filtering from the top of the page should not
  // be yanked downwards — and this is what makes it safe to call on every
  // keystroke of a search: the first one moves you, the rest find nothing to do.
  // Jumps rather than smooth-scrolls: the content has been replaced wholesale,
  // and animating 3000px of a list that no longer exists reads as a glitch.
  function resetListScroll(){
    var target = listTopOffset();
    if(window.scrollY > target + 1) window.scrollTo(0, target);
  }

  catTrigger.addEventListener('click', function(){
    if(catMenu.hidden) openCatMenu(); else closeCatMenu();
  });
  // ↓/↑ on the closed trigger opens the menu (Enter/Space already do, via click).
  catTrigger.addEventListener('keydown', function(e){
    if(catMenu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')){ e.preventDefault(); openCatMenu(); }
  });
  catMenu.addEventListener('click', function(e){
    var opt = e.target.closest('.cat-option');
    if(!opt) return;
    state.cat = opt.dataset.cat;
    closeCatMenu();
    renderCatTrigger();
    render();
    resetListScroll();
    syncUrl();
    catTrigger.focus();
  });

  var searchEl = document.getElementById('q');
  searchEl.addEventListener('input', function(e){
    state.query = e.target.value.trim().toLowerCase();
    render();
    resetListScroll();
    syncUrl();
  });

  document.querySelectorAll('.sortbtn').forEach(function(btn){
    btn.addEventListener('click', function(){
      var key = btn.dataset.sort;
      if(state.sortKey === key){ state.sortDir = state.sortDir==='asc' ? 'desc':'asc'; }
      else { state.sortKey = key; state.sortDir = key==='title' ? 'asc':'desc'; }
      document.querySelectorAll('.sortbtn').forEach(function(b){ b.dataset.active = (b===btn); });
      render();
      resetListScroll();
    });
  });

  // ---- List / gallery view toggle ----
  var viewToggle = document.getElementById('viewToggle');
  function applyView(){
    document.body.classList.toggle('view-grid', state.view==='grid');
    viewToggle.querySelectorAll('.view-btn').forEach(function(b){
      b.setAttribute('aria-pressed', b.dataset.view===state.view);
    });
  }
  viewToggle.addEventListener('click', function(e){
    var btn = e.target.closest('.view-btn');
    if(!btn || btn.dataset.view===state.view) return;
    state.view = btn.dataset.view;
    try { localStorage.setItem('wbai-view', state.view); } catch(err){}
    applyView();
    render();
    resetListScroll();
  });
  applyView();

  var rowsEl = document.getElementById('rows');
  var emptyEl = document.getElementById('emptyState');
  var loadingEl = document.getElementById('loadingState');
  var countEl = document.getElementById('resultCount');
  var clockEl = document.getElementById('clock');

  // #resultCount carries two very different kinds of message: the running tally
  // ("533 shows found") and one-off status ("Loading shows…", "Could not load
  // the archive."). Phones hide the tally to buy back a line — but hiding the
  // element outright would take the error message with it, which is exactly
  // when you most need to see something. So the tally is marked, and only the
  // marked state is hidden.
  //
  // .is-count uses .visually-hidden's clip technique, NOT display:none: the
  // element is role="status" aria-live="polite", and display:none would stop it
  // announcing "69 shows found" after a search — the one moment the count is
  // genuinely useful to a screen-reader user. It stays spoken, it just stops
  // taking space.
  function setCount(text, isTally){
    countEl.textContent = text;
    countEl.classList.toggle('is-count', !!isTally);
  }

  // ---------------- Overlay background state ----------------
  // Two things must be true of the page behind an open overlay: it is not
  // reachable, and it does not move.
  //
  // NOT REACHABLE. Focus is already Tab-trapped inside each modal, but a
  // screen-reader virtual cursor (VoiceOver swipe / NVDA browse) can still
  // wander into the listing behind it. Marking the appbar + main `inert`
  // removes them from both the focus order and the a11y tree.
  //
  // DOES NOT MOVE. Each overlay sets its own body.*-open class, and those were
  // believed to lock scroll — they don't, and never did. The lock has to sit on
  // <html>, which is what actually scrolls here; see the `html.scroll-lock`
  // comment in styles.css for the full trap. Driving it from this one function
  // (rather than per-overlay, like the body classes) is what keeps it honest.
  //
  // Both read the real .show state rather than counting opens, so nested cases
  // stay correct: the lightbox over the sheet, or the sheet handing off to the
  // live player, never prematurely un-inert or unlock the background.
  //
  // Call after toggling .show — and in close handlers, BEFORE returning focus,
  // so a trigger in the (now un-inert) header is focusable again.
  function refreshOverlayState(){
    var anyOpen = document.querySelector(
      '.menu-panel.show, .sheet.show, .lightbox.show, .live-player.show, .donate-modal.show'
    );
    ['.appbar', 'main#top'].forEach(function(sel){
      var el = document.querySelector(sel);
      if(!el) return;
      if(anyOpen) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    });
    document.documentElement.classList.toggle('scroll-lock', !!anyOpen);
  }

  // ---------------- Infinite scroll ----------------
  // Render the filtered list in pages and append more as the sentinel scrolls
  // into view, so the DOM never holds all ~500 rows at once.
  var PAGE_SIZE = 40;
  var filtered = [];   // current filtered + sorted list
  var shown = 0;       // how many of `filtered` are in the DOM

  var sentinel = document.createElement('div');
  sentinel.className = 'scroll-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');
  rowsEl.parentNode.insertBefore(sentinel, rowsEl.nextSibling);

  var io = ('IntersectionObserver' in window)
    ? new IntersectionObserver(function(entries){
        if(entries[0].isIntersecting) showMore();
      }, { rootMargin: '600px 0px' })
    : null;
  if(io) io.observe(sentinel);

  function showMore(){
    if(shown >= filtered.length) return;
    var next = filtered.slice(shown, shown + PAGE_SIZE);
    rowsEl.insertAdjacentHTML('beforeend', renderRows(next));
    shown += next.length;
    // Without an observer (old browsers), fall back to rendering everything.
    if(!io) while(shown < filtered.length) showMore();
  }

  function svgPlay(){ return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'; }
  function svgPause(){ return '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'; }
  function svgRss(){ return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"/><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/></svg>'; }
  function svgSpin(){ return '<span class="btn-spin"></span>'; }
  function svgLink(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>'; }
  function svgFacebook(){ return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 21v-8h2.7l.4-3h-3.1V8.1c0-.9.3-1.5 1.5-1.5H16.7V4c-.3 0-1.3-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3V10H7.3v3H10v8h3.5z"/></svg>'; }
  function svgShare(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>'; }

  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function render(){
    var list = rows.filter(function(r){
      if(state.cat!=='all' && r.cat!==state.cat) return false;
      if(state.query){
        var hay = (r.title+' '+CAT_BY_KEY[r.cat].label+' '+r.host).toLowerCase();
        if(hay.indexOf(state.query)===-1) return false;
      }
      return true;
    });
    list.sort(function(a,b){
      var dir = state.sortDir==='asc' ? 1 : -1;
      if(state.sortKey==='title') return a.title.localeCompare(b.title)*dir;
      if(state.sortKey==='daysLeft') return (a.daysLeft-b.daysLeft)*dir;
      // 'archive' — the order archive2 itself lists them in, which is what the
      // app shows on load so the two listings read the same top to bottom. Their
      // page is not date-sorted; recent recordings are appended in ingestion
      // order. `ord` carries that position. Ascending = their top row first, so
      // this key alone ignores sortDir until someone picks a column.
      if(state.sortKey==='archive') return (a.ord||0) - (b.ord||0);
      return (a.dt - b.dt)*dir;
    });

    loadingEl.hidden = true;
    setCount(list.length + (list.length===1 ? ' show':' shows') + ' found', true);
    emptyEl.hidden = list.length!==0;

    // reset paging: show the first page, append the rest on scroll
    filtered = list;
    shown = 0;
    rowsEl.innerHTML = '';
    showMore();
  }

  function renderRows(list){
    return state.view==='grid' ? renderCards(list) : renderList(list);
  }

  // Shared bits: computes per-show display state and the data-* attributes every
  // play button needs. `.play-glyph` wraps the icon so updatePlayButtons can swap
  // it without wiping the card artwork the button also contains.
  function playAttrs(r, subLine, photo, isLoading, isPlaying){
    return 'data-mp3="'+esc(r.mp3)+'" data-title="'+esc(r.title)+'" data-sub="'+esc(subLine)+'" data-photo="'+esc(photo)+'"'+
      ' aria-label="'+(isLoading?'Loading':(isPlaying?'Pause':'Play'))+' '+esc(r.title)+'"';
  }
  function glyph(isLoading, isPlaying){
    return '<span class="play-glyph">'+(isLoading ? svgSpin() : (isPlaying ? svgPause() : svgPlay()))+'</span>';
  }

  function renderList(list){
    return list.map(function(r){
      var c = CAT_BY_KEY[r.cat];
      var rc = retentionClass(r.daysLeft);
      var dparts = splitDateText(r.dateText);
      var isLoading = (loadingMp3===r.mp3);
      var isPlaying = (nowPlaying.mp3===r.mp3 && !audio.paused && !audio.ended && !isLoading);
      // kept raw: playAttrs escapes it for the data-* attribute, and the player
      // bar prints it with textContent
      var subLine = c.label + (r.host ? ' · with '+r.host : '');
      var photo = r.photo || '';
      return (
      '<div class="row body" role="row" data-id="'+esc(r.id)+'">'+
        '<div class="show-cell">'+
          // The artwork opens the sheet too. Like the player bar's art it is
          // aria-hidden with tabindex=-1: a second tab stop to the same place,
          // labelled only by an image, is noise for keyboard and screen readers.
          // The titled button beside it is the accessible stop.
          '<button class="show-thumb show-open" type="button" data-id="'+esc(r.id)+'" tabindex="-1" aria-hidden="true">'+
            (photo ? '<img loading="lazy" alt="" src="'+photo+'">' : '')+
          '</button>'+
          '<span class="show-text">'+
            // title + category open the info sheet; the play button on the right plays
            '<button class="show-open" type="button" data-id="'+esc(r.id)+'" aria-label="More about '+esc(r.title)+'">'+
              '<span class="show-title">'+esc(r.title)+'</span>'+
              '<span class="show-cat">'+esc(subLine)+' <span class="cell-duration inline-meta">· '+esc(r.length)+'</span></span>'+
            '</button>'+
            '<button class="more-link" type="button" data-id="'+esc(r.id)+'" tabindex="-1">More</button>'+
          '</span>'+
          (showRss(r) ?'<a class="rss-badge" href="'+RSS_BASE+encodeURIComponent(r.sho)+'" target="_blank" rel="noopener noreferrer" title="Subscribe to the RSS feed for '+esc(r.title)+'">'+svgRss()+'</a>' : '')+
        '</div>'+
        '<div class="cell-date"><b>'+esc(dparts.date)+'</b><span>'+esc(dparts.time)+'</span></div>'+
        '<div class="cell-mono cell-duration">'+esc(r.length)+'</div>'+
        '<div><span class="retention '+rc+'">'+retentionLabel(r.daysLeft)+'</span></div>'+
        '<div class="row-actions">'+
          '<button class="play-btn'+(isPlaying?' playing':'')+(isLoading?' loading':'')+'" '+playAttrs(r, subLine, photo, isLoading, isPlaying)+'>'+glyph(isLoading, isPlaying)+'</button>'+
        '</div>'+
      '</div>');
    }).join('');
  }

  // Podcast-style gallery card: big square artwork that is itself the play button,
  // with the title overlaid on a bottom fade, a category eyebrow, a centered play
  // glyph, and a retention badge.
  function renderCards(list){
    return list.map(function(r){
      var c = CAT_BY_KEY[r.cat];
      var d = new Date(r.dt*1000);
      var compactDate = MONTHS[d.getMonth()] + ' ' + d.getDate();
      var isLoading = (loadingMp3===r.mp3);
      var isPlaying = (nowPlaying.mp3===r.mp3 && !audio.paused && !audio.ended && !isLoading);
      var subLine = c.label + (r.host ? ' · with '+r.host : '');
      var photo = r.photo || '';
      return (
      '<div class="card-wrap">'+
        '<button class="card card-art play-btn'+(isPlaying?' playing':'')+(isLoading?' loading':'')+'" data-id="'+esc(r.id)+'" '+playAttrs(r, subLine, photo, isLoading, isPlaying)+'>'+
          (photo ? '<img loading="lazy" alt="" src="'+photo+'">' : '')+
          '<span class="card-fade" aria-hidden="true"></span>'+
          '<span class="card-play">'+glyph(isLoading, isPlaying)+'</span>'+
          '<span class="card-date">'+esc(compactDate)+'</span>'+
        '</button>'+
        // Title block and More sit outside the card button (a button can't nest)
        // but read as part of the artwork: the square plays, the text opens info.
        '<button class="card-overlay show-open" type="button" data-id="'+esc(r.id)+'" aria-label="More about '+esc(r.title)+'">'+
          '<span class="card-eyebrow">'+esc(c.label)+'</span>'+
          '<span class="card-title">'+esc(r.title)+'</span>'+
        '</button>'+
        '<button class="more-link card-more" type="button" data-id="'+esc(r.id)+'" tabindex="-1">More</button>'+
      '</div>');
    }).join('');
  }

  // ---------------- Persistent audio player ----------------
  var audio = document.getElementById('mainAudio');
  var playerBar = document.getElementById('playerBar');
  var playerTitle = document.getElementById('playerTitle');
  var playerSub = document.getElementById('playerSub');
  var playerStatus = document.getElementById('playerStatus');
  var playerIcon = document.getElementById('playerIcon');
  var playerToggle = document.getElementById('playerToggle');
  var playerClose = document.getElementById('playerClose');
  var playerRange = document.getElementById('playerRange');
  var playerCurrent = document.getElementById('playerCurrent');
  var playerDuration = document.getElementById('playerDuration');
  var playerPhoto = document.getElementById('playerPhoto');
  // fall back to the station icon (art background) if a show photo fails to load
  playerPhoto.addEventListener('error', function(){ playerPhoto.removeAttribute('src'); });

  function setPlayerPhoto(src){
    if(src){ playerPhoto.src = src; }
    else { playerPhoto.removeAttribute('src'); }
  }

  // The active archive track. title/sub/photo are kept here (not just painted into
  // the player bar) because the Media Session needs them again on every replay.
  var nowPlaying = { mp3:null, title:'', sub:'', photo:'' };
  var loadingMp3 = null;
  var seeking = false;   // true while the user drags the scrubber
  // Which source owns the docked bar: 'archive' (a seekable mp3, full scrubber) or
  // 'live' (the stream — scrubber and ±15s hidden, play/pause + close only).
  var barMode = null;

  function formatTime(sec){
    if(!isFinite(sec) || sec < 0) return '0:00';
    sec = Math.floor(sec);
    var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    var mm = h ? (m<10?'0'+m:''+m) : ''+m;
    return (h ? h+':' : '') + mm + ':' + (s<10?'0'+s:''+s);
  }
  // ---------------- Resume position ----------------
  // These are 1–2 hour talk broadcasts, so where you stopped listening is the
  // single most valuable thing the player can remember. Positions are keyed by
  // mp3 URL: the archive hands out no stable episode id, and the URL is both
  // unique per episode and gone from the listing the moment it rotates out.
  var RESUME_KEY = 'wbai-resume';
  var RESUME_MIN = 30;    // the first half minute isn't yet "a place" worth keeping
  var RESUME_TAIL = 60;   // inside the last minute counts as finished, not paused
  var RESUME_MAX = 120;   // entries retained; least recently touched dropped first
  var resumeMap = null;   // read from storage lazily, then held in memory

  function resumeAll(){
    if(resumeMap) return resumeMap;
    resumeMap = {};
    try {
      var raw = JSON.parse(localStorage.getItem(RESUME_KEY) || '{}');
      if(raw && typeof raw === 'object') resumeMap = raw;
    } catch(e){ /* private mode, quota, or garbage in the key — start empty */ }
    return resumeMap;
  }
  function resumeStore(){
    try { localStorage.setItem(RESUME_KEY, JSON.stringify(resumeAll())); } catch(e){}
  }
  // Episodes rotate out of the archive but their entries here don't, so the map
  // is trimmed to the most recently touched RESUME_MAX whenever it outgrows it.
  function resumePrune(){
    var map = resumeAll();
    var keys = Object.keys(map);
    if(keys.length <= RESUME_MAX) return;
    keys.sort(function(a,b){ return (map[b].at||0) - (map[a].at||0); });
    for(var i=RESUME_MAX; i<keys.length; i++) delete map[keys[i]];
  }
  function resumeFor(mp3){
    var rec = mp3 && resumeAll()[mp3];
    return (rec && isFinite(rec.t) && rec.t >= RESUME_MIN) ? rec.t : 0;
  }
  function resumeForget(mp3){
    if(!mp3) return;
    var map = resumeAll();
    if(!(mp3 in map)) return;
    delete map[mp3];
    resumeStore();
  }
  // Called on pause, on track change, on unload, and every few seconds of play.
  function resumeRemember(){
    var mp3 = nowPlaying.mp3, t = audio.currentTime, d = audio.duration;
    if(!mp3 || !isFinite(t)) return;
    if(t < RESUME_MIN || (isFinite(d) && d > 0 && t > d - RESUME_TAIL)){ resumeForget(mp3); return; }
    resumeAll()[mp3] = { t: Math.floor(t), d: isFinite(d) ? Math.floor(d) : 0, at: Date.now() };
    resumePrune();
    resumeStore();
  }

  // Restoring can't happen until the element knows its duration, so playTrack()
  // parks the offset here and `loadedmetadata` spends it.
  var pendingResume = 0;
  var lastResumeSync = 0;   // seconds; throttles resumeRemember from timeupdate

  var resumeToast = document.getElementById('resumeToast');
  var resumeToastTime = document.getElementById('resumeToastTime');
  function showResumeToast(sec){
    resumeToastTime.textContent = formatTime(sec);
    resumeToast.hidden = false;
    clearTimeout(showResumeToast.timer);
    showResumeToast.timer = setTimeout(hideResumeToast, 9000);
  }
  function hideResumeToast(){
    clearTimeout(showResumeToast.timer);
    resumeToast.hidden = true;
  }

  // "Start over" for the episode already loaded in the element.
  function startOver(){
    hideResumeToast();
    pendingResume = 0;
    if(!nowPlaying.mp3) return;
    resumeForget(nowPlaying.mp3);
    if(isFinite(audio.duration)) audio.currentTime = 0;
    lastResumeSync = 0;
    paintScrubTime();
    updatePositionState();
    updatePlayButtons();
  }

  document.getElementById('resumeRestart').addEventListener('click', startOver);
  document.getElementById('resumeDismiss').addEventListener('click', hideResumeToast);
  // A throttled save covers ordinary listening; this covers closing the tab
  // between two of those saves.
  window.addEventListener('pagehide', resumeRemember);

  // The sheet's Play button is the one control with room to spell the offer out.
  function playLabelFor(mp3, isLoading, isPlaying){
    if(isLoading) return 'Loading…';
    if(isPlaying) return 'Pause';
    var t = resumeFor(mp3);
    return t ? 'Resume ' + formatTime(t) : 'Play episode';
  }

  // Every scrubber wired to the same <audio>: the docked player bar always, plus
  // the info sheet's while it is open on the episode that is playing.
  function scrubs(){
    var list = [{range:playerRange, current:playerCurrent, duration:playerDuration}];
    var sr = document.getElementById('sheetRange');
    if(sr) list.push({
      range: sr,
      current: document.getElementById('sheetCurrent'),
      duration: document.getElementById('sheetDuration')
    });
    return list;
  }
  function setScrubFill(){
    scrubs().forEach(function(s){
      var max = +s.range.max || 0;
      s.range.style.setProperty('--pct', max ? (+s.range.value / max) * 100 : 0);
    });
  }
  function resetScrubber(){
    seeking = false;
    scrubs().forEach(function(s){
      s.range.disabled = true;
      s.range.max = 0;
      s.range.value = 0;
      if(s.current) s.current.textContent = '0:00';
      if(s.duration) s.duration.textContent = '0:00';
    });
    setScrubFill();
  }
  function applyDuration(){
    if(isFinite(audio.duration) && audio.duration > 0){
      scrubs().forEach(function(s){
        s.range.max = Math.floor(audio.duration);
        s.range.disabled = false;
        if(s.duration) s.duration.textContent = formatTime(audio.duration);
      });
    }
    setScrubFill();
  }
  function paintScrubTime(){
    scrubs().forEach(function(s){
      s.range.value = Math.floor(audio.currentTime);
      if(s.current) s.current.textContent = formatTime(audio.currentTime);
    });
    setScrubFill();
  }
  // live preview while dragging one scrubber; the other mirrors it
  function bindRange(range){
    if(!range) return;
    range.addEventListener('input', function(){
      seeking = true;
      scrubs().forEach(function(s){
        s.range.value = range.value;
        if(s.current) s.current.textContent = formatTime(+range.value);
      });
      setScrubFill();
    });
    range.addEventListener('change', function(){
      if(isFinite(audio.duration)) audio.currentTime = +range.value;
      seeking = false;
      updatePositionState();
    });
  }

  function showPlayerBar(){
    playerBar.hidden = false;
    document.body.classList.add('has-player');
  }
  function hidePlayerBar(){
    playerBar.hidden = true;
    document.body.classList.remove('has-player');
  }

  function setStatus(html){ playerStatus.innerHTML = html; }

  function refreshToggleIcon(){
    // Live has no "paused element" to read — a stopped stream has no element at
    // all — so the bar reads the intent flag the live section owns.
    var playing = (barMode === 'live')
      ? !!liveWanted
      : (!audio.paused && !audio.ended);
    playerIcon.outerHTML = playing
      ? '<svg id="playerIcon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
      : '<svg id="playerIcon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    playerIcon = document.getElementById('playerIcon');
  }

  function updatePlayButtons(){
    document.querySelectorAll('.play-btn').forEach(function(btn){
      var mp3 = btn.dataset.mp3;
      var loading = (mp3 === loadingMp3);
      var playing = (mp3 === nowPlaying.mp3) && !audio.paused && !audio.ended && !loading;
      btn.classList.toggle('playing', playing);
      btn.classList.toggle('loading', loading);
      var g = btn.querySelector('.play-glyph');
      if(g) g.innerHTML = loading ? svgSpin() : (playing ? svgPause() : svgPlay());
      // the info sheet's button is the only one that spells its state out in words
      var lbl = btn.querySelector('.play-label');
      if(lbl) lbl.textContent = playLabelFor(mp3, loading, playing);
      btn.setAttribute('aria-label', (loading?'Loading ':(playing?'Pause ':'Play ')) + btn.dataset.title);
    });
    refreshToggleIcon();
    syncSheetScrub();
    syncSheetRestart();
    paintSheetCloseBtn();   // what closing the sheet now means changed with it
  }

  // `fromStart` is the sheet's "Start over" asking for an episode that isn't the
  // one currently loaded; everything else picks up where the listener left off.
  function playTrack(mp3, title, sub, photo, fromStart){
    resumeRemember();      // the outgoing episode keeps its place
    hideResumeToast();
    if(fromStart) resumeForget(mp3);
    pendingResume = fromStart ? 0 : resumeFor(mp3);
    lastResumeSync = 0;
    nowPlaying.mp3 = mp3;
    nowPlaying.title = title || '';
    nowPlaying.sub = sub || '';
    nowPlaying.photo = photo || '';
    loadingMp3 = mp3;
    playerTitle.textContent = title;
    playerSub.textContent = sub;
    setPlayerPhoto(photo);
    setStatus('Loading…');
    resetScrubber();
    barMode = 'archive';
    playerBar.classList.remove('live');
    showPlayerBar();
    stopLive();                   // hand the bar to the archive track
    audio.src = mp3;
    audio.play().catch(function(){ /* surfaced by the error event below */ });
    updatePlayButtons();
  }

  // Metadata is (re)published on `play` rather than in playTrack(): iOS Safari can
  // overwrite session metadata that was set before playback was initiated.
  audio.addEventListener('play', function(){ activateArchiveSession(); });
  audio.addEventListener('playing', function(){
    loadingMp3 = null; setStatus('Playing'); updatePlayButtons();
    setPlaybackState('playing'); updatePositionState();
  });
  audio.addEventListener('pause', function(){
    loadingMp3 = null; if(!audio.ended) setStatus('Paused'); updatePlayButtons();
    setPlaybackState('paused'); updatePositionState();
    resumeRemember();
  });
  audio.addEventListener('ended', function(){
    loadingMp3 = null; setStatus('Finished');
    setPlaybackState('paused');
    // heard to the end: there is no place left to return to
    resumeForget(nowPlaying.mp3);
    hideResumeToast();
    updatePlayButtons();
  });

  // ---- scrubber wiring ----
  audio.addEventListener('loadedmetadata', function(){
    // The saved offset is spent here, once a duration exists to sanity-check it
    // against. A position past the end would otherwise land mid-nowhere.
    if(pendingResume > 0){
      var at = pendingResume;
      pendingResume = 0;
      if(isFinite(audio.duration) && at < audio.duration - RESUME_TAIL){
        audio.currentTime = at;
        showResumeToast(at);
      }
    }
    applyDuration();
    paintScrubTime();
    updatePositionState();
  });
  audio.addEventListener('timeupdate', function(){
    if(seeking) return;
    paintScrubTime();
    // timeupdate fires ~4x/sec; the OS position bar only needs about 1.
    if(audio.currentTime - lastPositionSync >= 1 || audio.currentTime < lastPositionSync){
      lastPositionSync = audio.currentTime;
      updatePositionState();
    }
    // and localStorage needs far less than that
    if(Math.abs(audio.currentTime - lastResumeSync) >= 5){
      lastResumeSync = audio.currentTime;
      resumeRemember();
    }
  });
  bindRange(playerRange);
  audio.addEventListener('waiting', function(){ setStatus('Buffering…'); });
  audio.addEventListener('error', function(){
    loadingMp3 = null;
    // Points at WBAI's archive page, not the mp3 itself. The old link handed out
    // the file URL directly — a download by another name, and mislabelled, since
    // it opened archive2.wbai.org's raw audio rather than a wbai.org page.
    setStatus('Playback blocked here — <a href="'+ARCHIVE_PAGE+'" target="_blank" rel="noopener noreferrer">open on wbai.org →</a>');
    updatePlayButtons();
  });

  rowsEl.addEventListener('click', function(e){
    // the title/category block and the "More" link under it open the info sheet;
    // the play control keeps working exactly as before
    var opener = e.target.closest('.more-link, .show-open');
    if(opener){ openSheetById(opener.dataset.id, opener); return; }

    var btn = e.target.closest('.play-btn');
    if(btn){
      // On a gallery card the artwork play control does what the title/More do —
      // it opens the info sheet. It does *not* autoplay; playback is started
      // deliberately from the sheet's Play button. List-view play buttons play.
      if(btn.classList.contains('card-art') && btn.dataset.id){
        openSheetById(btn.dataset.id, btn);
        return;
      }
      togglePlayFrom(btn);
      return;
    }

    // Everything else in a list row opens the sheet — not just the title block.
    // On a phone the row is ~100px tall and the only live targets in it were a
    // one-line title and a 15px "More", so most of the row read as tappable and
    // wasn't. Excluded: .row-actions (the play column owns its own taps, and a
    // near-miss there should do nothing rather than something else) and
    // .rss-badge, which navigates.
    var row = e.target.closest('.row.body[data-id]');
    if(row && !e.target.closest('.row-actions, .rss-badge')){
      // A drag that selected text ends in a click too; that isn't a tap.
      var sel = window.getSelection && window.getSelection();
      if(sel && sel.toString() && !sel.isCollapsed) return;
      openSheetById(row.dataset.id, row.querySelector('.show-text .show-open'));
    }
  });

  // Any element carrying the play button's data-* attributes can drive playback:
  // list rows, gallery cards, and the info sheet's Play button all share this.
  function togglePlayFrom(btn){
    var mp3 = btn.dataset.mp3;
    if(!mp3 || mp3 === loadingMp3) return;
    if(nowPlaying.mp3 === mp3 && !audio.paused && !audio.ended){
      audio.pause();
    } else {
      playTrack(mp3, btn.dataset.title, btn.dataset.sub, btn.dataset.photo);
    }
  }

  // Show artwork is layered on top of the category placeholder and paints itself
  // once decoded (cached or not — no load event to miss). If it errors, hide it
  // so the placeholder shows through.
  rowsEl.addEventListener('error', function(e){
    if(e.target && e.target.tagName === 'IMG') e.target.classList.add('failed');
  }, true);

  playerToggle.addEventListener('click', function(){ togglePlayback(); });
  // seekBy() is a declaration in the Media Session section below, hoisted here.
  document.getElementById('playerBack').addEventListener('click', function(){ seekBy(-SKIP_SECONDS); });
  document.getElementById('playerFwd').addEventListener('click', function(){ seekBy(SKIP_SECONDS); });

  // Whichever player currently owns the bar. Shared by the toggle button and the
  // Space shortcut so they can never disagree.
  function togglePlayback(){
    // barMode is the source of truth for what the bar controls: a live takeover
    // can leave a paused archive track in nowPlaying, so check the mode first.
    if(barMode === 'live'){ toggleLive(); return; }
    if(nowPlaying.mp3){
      if(audio.paused) audio.play().catch(function(){}); else audio.pause();
      return;
    }
    if(liveEngaged) toggleLive();
  }
  playerClose.addEventListener('click', function(){
    // Live mode: stop the stream and drop the bar, nothing archive-specific.
    if(barMode === 'live'){
      stopLive();
      barMode = null;
      playerBar.classList.remove('live');
      setStatus('');
      hidePlayerBar();
      if(mediaMode === 'live') clearMediaSession();
      return;
    }
    // before anything else: the `pause` event is async, and by the time it fires
    // nowPlaying is cleared and load() has reset currentTime to 0
    resumeRemember();
    hideResumeToast();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    nowPlaying.mp3 = null;
    nowPlaying.title = nowPlaying.sub = nowPlaying.photo = '';
    pendingResume = 0;
    barMode = null;
    resetScrubber();
    hidePlayerBar();
    updatePlayButtons();
    clearMediaSession();
  });

  // The player bar's art + title open the info sheet for whatever is playing.
  // The track is identified by its mp3 (unique per episode), so we find its row
  // and reuse the same opener the list and cards use. openSheetById/rowByMp3 are
  // function declarations in the sheet section below, hoisted into scope here.
  (function(){
    var infoBtn = document.getElementById('playerInfoBtn');
    function openForPlaying(){
      if(barMode === 'live'){ openLivePlayer(); return; }
      var r = nowPlaying.mp3 && rowByMp3(nowPlaying.mp3);
      if(r) openSheetById(r.id, infoBtn);
    }
    document.querySelectorAll('.player-open').forEach(function(el){
      el.addEventListener('click', openForPlaying);
    });
  })();

  // ---------------- Live stream + on-air metadata (modal player) ----------------
  // The On Air button in the appbar opens #livePlayer; the modal is the whole
  // live experience now. Audio flows through a live <audio> element (built per
  // connection — see "one connection, never reused" below) and the same
  // media-session plumbing the header strip used before.
  var onAirBtn = document.getElementById('onAirBtn');
  var livePlayer = document.getElementById('livePlayer');
  var livePlayerScrim = document.getElementById('livePlayerScrim');
  var lpClose = document.getElementById('lpClose');
  var lpArt = document.getElementById('lpArt');
  var lpTitle = document.getElementById('lpTitle');
  var lpHost = document.getElementById('lpHost');
  var lpTimes = document.getElementById('lpTimes');
  var lpToggle = document.getElementById('lpToggle');
  var lpIcon = document.getElementById('lpIcon');
  var lpVolumeWrap = document.getElementById('lpVolumeWrap');
  var lpVolume = document.getElementById('lpVolume');
  var lpNote = document.getElementById('lpNote');
  var lpUpNext = document.getElementById('lpUpNext');
  var lpUpNextText = document.getElementById('lpUpNextText');
  var lpSong = document.getElementById('lpSong');
  var lpSongText = document.getElementById('lpSongText');
  var lpAlert = document.getElementById('lpAlert');
  var lpAlertScrim = document.getElementById('lpAlertScrim');
  var lpAlertTitle = document.getElementById('lpAlertTitle');
  var lpAlertText = document.getElementById('lpAlertText');
  var lpAlertRetry = document.getElementById('lpAlertRetry');
  var lpAlertClose = document.getElementById('lpAlertClose');
  // ---- Live playback state. Three flags, each with one meaning:
  //   liveAudio   — the element carrying the CURRENT connection, or null when
  //                 there is no connection at all (stopped). Never reused.
  //   liveWanted  — user intent: the stream should be running right now. This,
  //                 not `element.paused`, is what every branch and icon reads.
  //   liveEngaged — live has been used at least once this session, so the bar
  //                 and the Space key are allowed to drive it.
  var liveAudio = null;
  var liveWanted = false;
  var liveEngaged = false;
  // The outgoing connection during a drift handover — still playing, still
  // audible, kept alive until its replacement proves it works. See resyncLive().
  var livePrev = null;
  var liveHandoverTimer = null;
  var liveErrored = false;
  // How long a play attempt may sit connecting before we call it a failure. A
  // dead stream host often does not error — the connection just never produces
  // audio — so the timeout is the only signal we get in that case.
  var LIVE_CONNECT_MS = 12000;
  var liveWatchdog = null;
  var liveAlertKind = '';
  var liveVolume = 1;
  // How far behind the live edge a running connection may fall before we swap it
  // for a fresh one, and how often that is allowed to happen.
  var LIVE_DRIFT_MS = 45000;
  var LIVE_RESYNC_MIN_MS = 30000;
  var liveResyncAt = 0;

  // Latest on-air snapshot, so the modal can paint whenever it opens and re-paint
  // as the schedule rolls over. Set by renderNowPlaying().
  var liveCurrent = null, liveNext = null, liveIsLive = false;

  function setLiveNote(text){ lpNote.textContent = text; }

  function setLiveIcon(playing){
    lpIcon.outerHTML = playing
      ? '<svg id="lpIcon" width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
      : '<svg id="lpIcon" width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    lpIcon = document.getElementById('lpIcon');
    lpToggle.classList.toggle('playing', playing);
    lpToggle.setAttribute('aria-pressed', playing ? 'true' : 'false');
    lpToggle.setAttribute('aria-label', playing ? 'Pause live stream' : 'Play live stream');
    // the appbar button doubles as a "you are listening" indicator; it always
    // just opens the modal — pause/stop lives in the docked player bar
    onAirBtn.classList.toggle('playing', playing);
    onAirBtn.setAttribute('aria-label', playing
      ? 'Live stream playing — open the player'
      : 'Open the live player — WBAI is on air now');
    // Resting label is a call-to-action ("Listen Live"); once the stream is
    // playing it reads "On Air", matching the animated equaliser.
    var onAirLabel = onAirBtn.querySelector('.on-air-label');
    if(onAirLabel) onAirLabel.textContent = playing ? 'On Air' : 'Listen Live';
    paintLiveCloseBtn();
  }

  function setLiveLoading(on){ lpToggle.classList.toggle('loading', on); }

  // ---- What the close button promises. Closing the modal has never stopped the
  // stream — it hands it to the docked bar — but an ✕ says "this ends", and
  // listeners had to discover on their own that the audio was still running. So
  // the control tells the truth: chevron-down + "keeps playing" whenever closing
  // hands something over, plain ✕ when it really does leave nothing behind.
  //
  // The test is `liveWanted`, i.e. user intent, not whether audio is audible yet
  // — closing mid-connect hands over just the same, and the bar arrives a moment
  // later. (The collapse *animation* has a stricter condition: it has to measure
  // the bar, so it needs the bar on screen. See closeLivePlayer.)
  function liveWillMinimize(){ return liveWanted; }
  function paintLiveCloseBtn(){
    var min = liveWillMinimize();
    lpClose.classList.toggle('minimize', min);
    lpClose.setAttribute('aria-label', min
      ? 'Minimize the live player — the stream keeps playing in the bar below'
      : 'Close live player');
    lpClose.setAttribute('title', min ? 'Minimize — keeps playing' : 'Close');
    // A live takeover changes barMode without touching archive playback, so the
    // sheet's close button can start or stop meaning "minimize" from right here.
    paintSheetCloseBtn();
  }

  lpArt.addEventListener('load', function(){ lpArt.classList.add('loaded'); });
  lpArt.addEventListener('error', function(){ lpArt.classList.remove('loaded'); lpArt.removeAttribute('src'); });
  function setLivePhoto(url){
    if(url && url !== lpArt.getAttribute('data-current')){
      lpArt.setAttribute('data-current', url);
      lpArt.classList.remove('loaded');
      lpArt.src = url;
    } else if(!url){
      lpArt.removeAttribute('data-current');
      lpArt.removeAttribute('src');
      lpArt.classList.remove('loaded');
    }
  }

  // ---- Failure alert. A failed stream reaches the page as an opaque MediaError,
  // so the modal shows a card that names the likely cause and offers a way out:
  // retry, or the station's own listen page. The wording is refined once
  // /api/livestatus reports whether the stream host answered the *server*, which
  // is what separates "WBAI is off the air" from "something on this device".
  // The alert is a dialog layered over the live player, so its visibility is
  // tied to the player's by hand (it used to be a child, which did that for
  // free). A failure while the player is closed is remembered, not thrown in the
  // listener's face: the bar already reads "Stream unavailable", and the dialog
  // is there when they open the player.
  var lpAlertReturnFocus = null;
  function showLiveAlert(kind, title, text){
    liveAlertKind = kind;
    lpAlertTitle.textContent = title;
    lpAlertText.textContent = text;
    livePlayer.classList.add('errored');
    setLiveNote('');
    paintLiveAlert();
  }
  function hideLiveAlert(){
    liveAlertKind = '';
    livePlayer.classList.remove('errored');
    paintLiveAlert();
  }
  function paintLiveAlert(){
    var want = !!liveAlertKind && livePlayer.classList.contains('show');
    if(want === !lpAlert.hidden) return;              // already in that state
    lpAlert.hidden = lpAlertScrim.hidden = !want;
    lpAlert.setAttribute('aria-hidden', want ? 'false' : 'true');
    if(want){
      // Capture focus BEFORE inerting the player — inert blurs whatever is
      // focused inside it, and by then there is nothing left to remember.
      var focused = document.activeElement;
      lpAlertReturnFocus = (focused && livePlayer.contains(focused)) ? focused : lpToggle;
      // aria-modal means what is behind must be unreachable, including the
      // player the dialog is sitting on top of.
      livePlayer.setAttribute('inert', '');
      document.addEventListener('keydown', onLiveAlertKey);
      lpAlertRetry.focus();
    } else {
      livePlayer.removeAttribute('inert');
      document.removeEventListener('keydown', onLiveAlertKey);
      if(lpAlertReturnFocus && lpAlertReturnFocus.focus) lpAlertReturnFocus.focus();
      lpAlertReturnFocus = null;
    }
  }
  // Escape dismisses the alert only — the player behind it stays open. This runs
  // ahead of the player's own Escape handler, which bails while the alert is up.
  function onLiveAlertKey(e){
    if(e.key === 'Escape'){ e.stopPropagation(); dismissLiveAlert(); return; }
    if(e.key !== 'Tab') return;
    var f = [].filter.call(
      lpAlert.querySelectorAll('a[href], button:not([disabled])'),
      function(el){ return el.offsetParent !== null; }
    );
    if(!f.length) return;
    var first = f[0], last = f[f.length-1];
    if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  }
  function dismissLiveAlert(){
    hideLiveAlert();
    setLiveNote('Tap play to try again');
  }

  function clearLiveWatchdog(){
    if(liveWatchdog){ clearTimeout(liveWatchdog); liveWatchdog = null; }
  }
  function armLiveWatchdog(){
    clearLiveWatchdog();
    liveWatchdog = setTimeout(function(){
      liveWatchdog = null;
      // it did start
      if(liveAudio && !liveAudio.paused && liveAudio.currentTime > 0) return;
      liveFailed('timeout');
    }, LIVE_CONNECT_MS);
  }

  // Single funnel for every way the stream can fail: the error event, a rejected
  // play(), or the watchdog. Leaves the player in a clean paused state so the
  // retry path is the ordinary play path.
  function liveFailed(reason){
    clearLiveWatchdog();
    // one failure, one alert: a dead source often reports twice (rejected play()
    // *and* an error event), and the retry path clears this flag before re-trying
    if(liveErrored && !lpAlert.hidden) return;
    var wasPlaying = !!(liveAudio && liveAudio.currentTime > 0);
    liveErrored = true;         // set first: stopLive() leaves the error UI alone
    stopLive();                 // throw the half-open connection away entirely
    if(barMode === 'live') setStatus('Stream unavailable');

    if(reason === 'blocked'){
      showLiveAlert('blocked', 'Your browser blocked playback',
        'Something on this device stopped the stream from starting — often an autoplay rule, an extension, or a content blocker. Tap Try again, or open the stream on wbai.org.');
      return;
    }
    if(navigator.onLine === false){
      showLiveAlert('offline', 'You’re offline',
        'This device has no internet connection right now, so the live stream can’t load. Reconnect and try again.');
      return;
    }
    showLiveAlert('checking',
      wasPlaying ? 'The live stream dropped' : 'Can’t reach the live stream',
      'Checking WBAI’s streaming server…');
    probeLiveServer();
  }

  function renderProbeResult(s){
    if(liveAlertKind !== 'checking') return;      // dismissed or retried meanwhile
    if(s && s.ok){
      showLiveAlert('local', 'The stream won’t play here',
        'WBAI’s streaming server is up and answering, so the problem is between it and this device — a VPN, firewall, or content blocker can cut off audio streams. Try again, or open the stream on wbai.org.');
      return;
    }
    var detail = (s && s.status) ? ' (it replied ' + s.status + ')'
               : (s && s.reason === 'timeout') ? ' (it timed out)' : '';
    showLiveAlert('down', 'WBAI’s live stream is down',
      'The station’s streaming server isn’t serving audio right now' + detail + '. That’s on WBAI’s end, not yours — try again in a few minutes. Archive shows still play normally.');
  }
  function probeLiveServer(){
    if(LIVE_FAIL === 'down'){ renderProbeResult({ ok:false, reason:'unreachable' }); return; }
    fetch('/api/livestatus', { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(renderProbeResult)
      .catch(function(){
        if(liveAlertKind !== 'checking') return;
        showLiveAlert('unknown', 'Can’t reach the live stream',
          'The stream didn’t start and we couldn’t check why. Check your connection and try again, or open the stream on wbai.org.');
      });
  }

  // Coming back online is the one recovery we can detect on our own; say so
  // rather than leaving a stale "you're offline" card on screen.
  window.addEventListener('online', function(){
    if(liveAlertKind !== 'offline') return;
    showLiveAlert('unknown', 'You’re back online',
      'Your connection is back. Tap Try again to tune in.');
  });

  lpAlertRetry.addEventListener('click', function(){
    hideLiveAlert();
    liveErrored = false;
    startLive();
  });
  lpAlertClose.addEventListener('click', dismissLiveAlert);
  lpAlertScrim.addEventListener('click', dismissLiveAlert);

  // ================= ONE CONNECTION, NEVER REUSED =================
  // A live stream has no timeline. An <audio> element that is paused and later
  // resumed picks up at the byte it stopped on, so it plays whatever sat in the
  // buffer at pause time — audio that is minutes old and can never catch up,
  // because there is no seekable range to jump forward in. That is the "it
  // played the cache" bug (2026-07-26): leave the page sitting, press play, hear
  // the past. docs/big-audio-bug.md §0 knowingly accepted this ("resume may be a
  // few seconds behind live"); in practice the gap is unbounded.
  //
  // That post-mortem also wrote the rule for fixing it: "go live" must be an
  // explicit mechanism and must never be folded into one element's pause/play
  // state machine. Every earlier attempt broke that rule — they tore down and
  // reconnected the SAME element (removeAttribute('src') / load() / cache-
  // buster), which left readyState/networkState/paused in transient states that
  // the next click then misread. So:
  //
  //   * There is no resume. STOP tears the connection down and THROWS THE
  //     ELEMENT AWAY. Its dying pause/error/emptied events are ignored (every
  //     handler checks it is still the current element) and nothing ever reads
  //     its state again, so those transient values cannot be observed at all.
  //   * PLAY builds a BRAND NEW <audio>, sets src on it once, and plays it. A
  //     fresh element starts at readyState 0 with an empty buffer, so a play can
  //     only ever open a new connection — at the live edge, by construction.
  //   * Branching is on `liveWanted`, a flag we own, never on `element.paused`
  //     (hypothesis H3 of the post-mortem).
  //
  // The element is therefore short-lived, and `liveAudio` may legitimately be
  // null. Nothing outside this section touches it — use startLive()/stopLive().

  // A unique query per connection. Icecast ignores it; it guarantees that no
  // layer between here and the station (HTTP cache, proxy, Safari's media cache)
  // can answer a new connection with the previous one's bytes.
  function liveSrc(){
    return LIVE_URL + (LIVE_URL.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
  }

  // Drift = wall-clock elapsed minus audio elapsed since this connection's first
  // frame. It is 0 on a healthy stream and grows with every stall, throttled
  // background tab, or laptop sleep — i.e. it measures exactly how far behind the
  // live edge we have fallen. The baseline is stamped once per connection: a
  // stall must never be allowed to reset it, or the lag it caused disappears.
  function markLiveEdge(el){
    if(el._wall) return;
    el._wall = Date.now();
    el._time = el.currentTime;
  }
  function liveDriftMs(){
    if(!liveAudio || !liveAudio._wall) return 0;
    return (Date.now() - liveAudio._wall) - ((liveAudio.currentTime - liveAudio._time) * 1000);
  }

  // Every connection gets its own element and its own listeners. A discarded
  // element still emits events while it is torn down, so each handler first
  // checks that it is still the current one and otherwise does nothing.
  function newLiveEl(){
    var el = document.createElement('audio');
    el.preload = 'none';
    el.volume = liveVolume;
    function current(fn){
      return function(){ if(el === liveAudio) fn(); };
    }
    el.addEventListener('play', claimAudioSession);
    el.addEventListener('waiting', current(function(){ if(liveWanted) setLiveLoading(true); }));
    el.addEventListener('playing', current(function(){
      markLiveEdge(el);
      clearLiveWatchdog();
      liveErrored = false;
      hideLiveAlert();
      setLiveLoading(false); setLiveIcon(true); setLiveNote('');
      activateLiveSession();
      showLiveBar();
      // Recovering from a stall is the moment we learn how far behind we are:
      // the element resumes at the byte it stopped on, so a 60s stall means 60s
      // behind live, forever. Deferred — resyncLive() may replace this element,
      // and doing that inside its own handler is asking for trouble.
      if(liveDriftMs() >= LIVE_DRIFT_MS) setTimeout(resyncLive, 0);
    }));
    el.addEventListener('error', current(function(){ liveFailed('error'); }));
    // A live stream has no end; 'ended' means the server closed the connection.
    el.addEventListener('ended', current(function(){ liveFailed('ended'); }));
    // A pause we did not ask for — an OS interruption, a headset unplug, another
    // app taking the audio session — is a stop, not a pause: that connection is
    // dead to us and the next play must open a new one.
    el.addEventListener('pause', current(function(){ if(liveWanted) stopLive(); }));
    document.body.appendChild(el);
    return el;
  }

  // Detach and abandon. removeAttribute('src') + load() is the spec's way to make
  // an element stop downloading, and it is safe *here* precisely because this
  // element is garbage the moment it returns — no branch ever reads it again.
  function destroyLiveEl(el){
    if(!el) return;
    try{
      el.pause();
      el.removeAttribute('src');
      el.load();
    }catch(e){ /* the element is on its way out either way */ }
    if(el.parentNode) el.parentNode.removeChild(el);
  }

  function stopLive(){
    clearLiveWatchdog();
    clearTimeout(liveHandoverTimer);
    var el = liveAudio, old = livePrev;
    liveAudio = null;            // from here, `el`'s remaining events are ignored
    livePrev = null;
    liveWanted = false;
    destroyLiveEl(el);
    destroyLiveEl(old);          // a half-finished handover must not be orphaned
    setLiveLoading(false);
    setLiveIcon(false);
    if(mediaMode === 'live') setPlaybackState('paused');
    if(liveErrored) return;      // liveFailed() owns the note and the bar status
    setLiveNote(liveEngaged ? 'Paused' : 'Tap play to tune in');
    if(barMode === 'live'){ refreshToggleIcon(); setStatus('Paused'); }
  }

  // The one and only way audio starts. Always a new element, always a new
  // connection, therefore always the live edge — whether it is the first play,
  // a play after a stop, a retry after a failure, or a drift resync.
  function startLive(){
    stopLive();                               // no-op when nothing is connected
    if(!audio.paused) audio.pause();          // the two players never run at once
    hideLiveAlert();
    liveErrored = false;
    liveWanted = true;
    liveEngaged = true;
    setLiveLoading(true);
    setLiveNote('Connecting…');
    if(barMode === 'live'){ refreshToggleIcon(); setStatus('Connecting…'); }
    paintLiveCloseBtn();          // connecting counts: closing now still hands over
    var el = liveAudio = newLiveEl();
    el.src = liveSrc();
    armLiveWatchdog();
    el.play().catch(function(err){
      // Stopping (or restarting) while play() is still pending rejects it with
      // AbortError. That is us, not a failure — only report for the live element.
      if(el !== liveAudio) return;
      liveFailed(err && err.name === 'NotAllowedError' ? 'blocked' : 'error');
    });
  }

  function toggleLive(){
    if(liveWanted) stopLive(); else startLive();
  }

  // Staying at the live edge without a click. A connection that is still running
  // can fall behind — a long stall, a throttled background tab, a sleeping
  // laptop — and it then plays that backlog forever, permanently behind.
  //
  // This is a HANDOVER, not a restart, and the difference matters: there is no
  // user gesture behind it, so `play()` on the replacement can simply be refused
  // (autoplay policy — confirmed in Chrome, and the same rule on iOS). So the
  // replacement has to prove it plays before the working connection is dropped,
  // and a refusal costs nothing: the old connection is handed back, still
  // audible, and the user's next tap gets them live the ordinary way.
  // Rate-limited, and never while hidden — a reconnect nobody is listening to
  // just churns the station's server.
  function resyncLive(){
    if(!liveWanted || !liveAudio || liveErrored || livePrev) return;
    if(document.visibilityState === 'hidden') return;
    if(liveDriftMs() < LIVE_DRIFT_MS) return;
    if(Date.now() - liveResyncAt < LIVE_RESYNC_MIN_MS) return;
    liveResyncAt = Date.now();

    var prev = liveAudio;
    var next = newLiveEl();
    livePrev = prev;             // `prev` keeps playing, but its events go quiet
    liveAudio = next;
    // Abandon a handover that never starts, or we would sit on two connections
    // with the silent one nominally in charge.
    liveHandoverTimer = setTimeout(function(){ handback(next, prev); }, LIVE_CONNECT_MS);
    next.src = liveSrc();
    next.play().then(function(){
      if(next !== liveAudio) return;         // superseded by a stop or a restart
      clearTimeout(liveHandoverTimer);
      livePrev = null;
      destroyLiveEl(prev);                   // only now is the old one expendable
    }).catch(function(){ handback(next, prev); });
  }
  function handback(next, prev){
    if(next !== liveAudio) return;
    clearTimeout(liveHandoverTimer);
    liveAudio = prev;            // whatever it is playing, it is playing something
    livePrev = null;
    destroyLiveEl(next);
  }
  document.addEventListener('visibilitychange', resyncLive);
  window.addEventListener('focus', resyncLive);
  window.addEventListener('online', resyncLive);
  window.addEventListener('pageshow', resyncLive);

  // ---- The docked player bar, in live mode. Playing the stream surfaces the same
  // bar the archive uses (so pause/navigation are persistent and familiar), with a
  // LIVE badge in place of the scrubber and ±15s.
  function paintLiveBar(){
    if(!liveCurrent) return;
    playerTitle.textContent = liveCurrent.name || 'WBAI 99.5 FM';
    // when a track is on air, showcase it in the sub-line (the LIVE badge already
    // carries the live state); otherwise fall back to the host + station
    var song = (liveCurrent.song || '').trim();
    var artist = (liveCurrent.artist || '').trim();
    if(song || artist){
      playerSub.textContent = '♪ ' + (song && artist ? (song + ' · ' + artist) : (song || artist));
    } else {
      playerSub.textContent = (liveCurrent.dj ? 'with ' + liveCurrent.dj + ' · ' : '') + 'WBAI 99.5 FM · Live';
    }
    setPlayerPhoto(liveCurrent.photo || '');
  }
  function showLiveBar(){
    barMode = 'live';
    playerBar.classList.add('live');
    paintLiveBar();
    setStatus('<span class="player-live"><span class="player-live-dot"></span>Live</span>');
    showPlayerBar();
    refreshToggleIcon();
  }

  audio.addEventListener('play', function(){ if(liveWanted) stopLive(); });

  // ---- Volume. New to the modal; the strip had none. Setting .volume is a no-op
  // on iOS (the OS owns it), so the slider is dropped there rather than shown dead.
  var LIVE_VOL_KEY = 'wbai:livevol';
  var canVolume = !(/iP(hone|od|ad)/.test(navigator.platform) ||
                    (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1));
  function paintVol(){ lpVolume.style.setProperty('--pct', (parseFloat(lpVolume.value) || 0) * 100); }
  if(canVolume){
    // The setting lives here, not on the element: each connection builds a new
    // <audio> and reads `liveVolume` when it does.
    var storedVol = parseFloat(localStorage.getItem(LIVE_VOL_KEY));
    if(isFinite(storedVol)){ liveVolume = storedVol; lpVolume.value = String(storedVol); }
    paintVol();
    lpVolume.addEventListener('input', function(){
      var v = parseFloat(lpVolume.value);
      liveVolume = v;
      if(liveAudio) liveAudio.volume = v;
      paintVol();
      try{ localStorage.setItem(LIVE_VOL_KEY, String(v)); }catch(e){}
    });
  } else {
    lpVolumeWrap.hidden = true;
  }

  // ---- Paint the modal from the latest snapshot. Safe to call any time.
  function paintLivePlayer(){
    if(!liveCurrent) return;
    setLivePhoto(liveCurrent.photo || null);
    lpTitle.textContent = liveCurrent.name || 'WBAI 99.5 FM';
    if(liveCurrent.dj){ lpHost.textContent = 'with ' + liveCurrent.dj; lpHost.hidden = false; }
    else { lpHost.hidden = true; }
    if(liveCurrent.start && liveCurrent.end){
      var times = liveCurrent.start + ' – ' + liveCurrent.end;
      if(!liveIsLive) times += ' · schedule may be delayed';
      lpTimes.textContent = times; lpTimes.hidden = false;
    } else { lpTimes.hidden = true; }
    if(liveNext && liveNext.name){
      lpUpNextText.textContent = liveNext.name + (liveNext.start ? ' · ' + liveNext.start : '');
      lpUpNext.hidden = false;
    } else { lpUpNext.hidden = true; }
    // Now-playing track — shown for any show (talk shows play intro songs too),
    // whenever the feed carries one; disappears the moment it clears it (the 15s
    // poll drives this repaint).
    var song = (liveCurrent.song || '').trim();
    var artist = (liveCurrent.artist || '').trim();
    if(song || artist){
      lpSongText.textContent = song && artist ? (song + ' · ' + artist) : (song || artist);
      lpSong.hidden = false;
    } else { lpSong.hidden = true; }
  }

  // ---- Modal open / close, mirroring the info sheet's lifecycle.
  var livePlayerReturnFocus = null;
  function openLivePlayer(){
    if(livePlayer.classList.contains('show')) return;
    if(typeof closeSheet === 'function' && sheet && sheet.classList.contains('show')) closeSheet();
    paintLivePlayer();
    // reflect whatever the stream is currently doing
    if(!lpAlert.hidden) setLiveNote('');          // the alert says it all
    else if(liveErrored) setLiveNote('Tap play to try again');
    else if(liveWanted) setLiveNote('');
    else if(liveEngaged) setLiveNote('Paused');
    else setLiveNote('Tap play to tune in');
    // opening the player is "I'm back" — the moment to check for a stale connection
    resyncLive();
    livePlayerReturnFocus = document.activeElement;
    endMinimize();         // re-opened mid-collapse: drop the transform, it wins
    paintLiveCloseBtn();
    livePlayer.classList.add('show');
    livePlayerScrim.classList.add('show');
    livePlayer.setAttribute('aria-hidden', 'false');
    onAirBtn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('sheet-open');
    refreshOverlayState();
    lpToggle.focus();
    document.addEventListener('keydown', onLivePlayerKey);
    paintLiveAlert();      // a failure that happened while this was closed
  }
  // ---- Collapse the card toward the player bar on close-while-playing, so the
  // handoff is something the listener watches happen instead of something they
  // find out about later. Pure decoration over the existing close: if the timer
  // never fires, or motion is reduced, the modal is already closed and correct.
  // Shared by both dialogs that close onto the bar: the live player and the show
  // info sheet. Only one of them can be open at a time, so one timer is enough.
  var MINIMIZE_MS = 360;
  var minimizeTimer = null;
  var minimizingPanel = null;
  function endMinimize(){
    clearTimeout(minimizeTimer);
    minimizeTimer = null;
    if(minimizingPanel){
      minimizingPanel.classList.remove('minimizing');
      minimizingPanel.style.removeProperty('--min-dy');
      minimizingPanel = null;
    }
    playerBar.classList.remove('arrived');
  }
  function runMinimize(panel){
    endMinimize();                          // a close during a previous run
    // How far the card's centre has to travel to reach the bar's. Measured
    // rather than guessed: the card's height depends on which metadata rows the
    // feed gave us, and the bar sits above the safe-area inset on phones.
    var card = panel.getBoundingClientRect();
    var bar = playerBar.getBoundingClientRect();
    var dy = (bar.top + bar.height / 2) - (card.top + card.height / 2);
    panel.style.setProperty('--min-dy', dy + 'px');
    panel.classList.add('minimizing');
    minimizingPanel = panel;
    // Land the bar's flash at the end of the travel, not the start of it.
    minimizeTimer = setTimeout(function(){
      panel.classList.remove('minimizing');
      panel.style.removeProperty('--min-dy');
      minimizingPanel = null;
      playerBar.classList.add('arrived');
      minimizeTimer = setTimeout(function(){
        playerBar.classList.remove('arrived');
        minimizeTimer = null;
      }, 600);
    }, MINIMIZE_MS);
  }

  function closeLivePlayer(){
    if(!livePlayer.classList.contains('show')) return;
    // The card can only collapse toward a bar that is on screen to be measured;
    // closing mid-connect (bar not docked yet) just closes.
    if(liveWillMinimize() && !playerBar.hidden) runMinimize(livePlayer);
    livePlayer.classList.remove('show');
    paintLiveAlert();      // the dialog goes with it; liveAlertKind is remembered
    livePlayerScrim.classList.remove('show');
    livePlayer.setAttribute('aria-hidden', 'true');
    onAirBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('sheet-open');
    document.removeEventListener('keydown', onLivePlayerKey);
    refreshOverlayState();
    if(livePlayerReturnFocus && livePlayerReturnFocus.focus) livePlayerReturnFocus.focus();
    livePlayerReturnFocus = null;
  }
  function onLivePlayerKey(e){
    if(!lpAlert.hidden) return;          // the alert dialog owns the keyboard
    if(e.key === 'Escape'){ closeLivePlayer(); return; }
    if(e.key !== 'Tab') return;
    var f = [].filter.call(
      livePlayer.querySelectorAll('a[href], button:not([disabled]), input:not([disabled])'),
      function(el){ return el.offsetParent !== null; }
    );
    if(!f.length) return;
    var first = f[0], last = f[f.length-1];
    if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  }

  onAirBtn.addEventListener('click', openLivePlayer);
  lpClose.addEventListener('click', closeLivePlayer);
  livePlayerScrim.addEventListener('click', closeLivePlayer);
  lpToggle.addEventListener('click', toggleLive);

  // ---------------- Keyboard shortcuts ----------------
  // Space = play/pause, ←/→ = ±SKIP_SECONDS, matching the lock screen and the
  // player bar's own controls. Three things must never be swallowed: typing in
  // the search field, a modifier combination the browser or OS owns, and Space
  // or Enter on a focused control, which belongs to that control.
  document.addEventListener('keydown', function(e){
    if(e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target || {};
    var tag = t.tagName;
    if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;

    if(e.key === ' ' || e.key === 'Spacebar'){
      // let a focused button or link handle its own activation
      if(tag === 'BUTTON' || tag === 'A') return;
      if(!nowPlaying.mp3 && !liveEngaged) return;
      e.preventDefault();               // otherwise Space scrolls the listing
      togglePlayback();
      return;
    }
    // Arrow keys only mean something for an archive track with a duration.
    if(e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
      if(!nowPlaying.mp3 || !isFinite(audio.duration)) return;
      e.preventDefault();
      seekBy(e.key === 'ArrowLeft' ? -SKIP_SECONDS : SKIP_SECONDS);
    }
  });

  // ---------------- Audio session (Safari 17+) ----------------
  // Declares this as primary media rather than an incidental sound, which is
  // what makes iOS keep it playing in the background and ignore the ringer
  // switch. Feature-detected and re-asserted on each play, because a session
  // claimed before any playback has begun does not always survive.
  function claimAudioSession(){
    try {
      if(navigator.audioSession && navigator.audioSession.type !== 'playback'){
        navigator.audioSession.type = 'playback';
      }
    } catch(e){ /* older Safari, or a value it won't accept */ }
  }
  claimAudioSession();
  audio.addEventListener('play', claimAudioSession);
  // the live element is built per connection; newLiveEl() binds this on each one

  // ---------------- Media Session: lock screen, hardware keys, car displays ----
  // Both <audio> elements share one OS-level session, so `mediaMode` tracks which
  // player currently owns it and the handlers are re-bound whenever that flips.
  var hasMediaSession = ('mediaSession' in navigator) && ('MediaMetadata' in window);
  var mediaMode = null;          // 'archive' | 'live' | null
  var lastPositionSync = 0;      // seconds; throttles setPositionState from timeupdate
  var SKIP_SECONDS = 15;

  // The station mark is always the last artwork entry: show photos come back from
  // the /pix proxy fairly small, and the OS falls through to the next entry when a
  // source is missing or fails to decode. Same-origin only — cross-origin artwork
  // is silently dropped by the OS.
  var STATION_ARTWORK = [
    {src:'/assets/icon-256.png', sizes:'256x256', type:'image/png'},
    {src:'/assets/app_icon_1024.png', sizes:'890x890', type:'image/png'}
  ];
  function artworkFor(photo){
    return (photo ? [{src:photo, sizes:'any', type:'image/jpeg'}] : []).concat(STATION_ARTWORK);
  }

  // setActionHandler throws on actions a browser doesn't know, so every call is guarded.
  function setHandler(action, fn){
    if(!hasMediaSession) return;
    try{ navigator.mediaSession.setActionHandler(action, fn); }catch(e){}
  }
  function setPlaybackState(state){
    if(!hasMediaSession) return;
    try{ navigator.mediaSession.playbackState = state; }catch(e){}
  }

  // Only the archive player has a real duration. For the live stream the position
  // state must be cleared, or the OS draws a scrubber that can never be accurate.
  function updatePositionState(){
    if(!hasMediaSession || !navigator.mediaSession.setPositionState) return;
    try{
      if(mediaMode !== 'archive'){ navigator.mediaSession.setPositionState(); return; }
      var d = audio.duration;
      if(!isFinite(d) || d <= 0) return;
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(Math.max(audio.currentTime, 0), d)
      });
    }catch(e){ /* non-finite duration mid-load; the next timeupdate retries */ }
  }

  function clearMediaSession(){
    if(!hasMediaSession) return;
    mediaMode = null;
    navigator.mediaSession.metadata = null;
    setPlaybackState('none');
    updatePositionState();
  }

  // ---- archive session ----
  function subLineFor(r){
    return CAT_BY_KEY[r.cat].label + (r.host ? ' · with ' + r.host : '');
  }
  // Steps through the list as currently filtered and sorted, so next/prev on a
  // headset follows what the user is actually looking at.
  function playNeighbor(step){
    if(!nowPlaying.mp3) return;
    var i = -1;
    for(var n = 0; n < filtered.length; n++){
      if(filtered[n].mp3 === nowPlaying.mp3){ i = n; break; }
    }
    var r = (i === -1) ? null : filtered[i + step];
    if(!r) return;
    playTrack(r.mp3, r.title, subLineFor(r), r.photo || '');
  }
  function seekBy(offset){
    if(!isFinite(audio.duration)) return;
    audio.currentTime = Math.min(Math.max(audio.currentTime + offset, 0), audio.duration);
    updatePositionState();
  }

  function activateArchiveSession(){
    if(!hasMediaSession || !nowPlaying.mp3) return;
    mediaMode = 'archive';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: nowPlaying.title,
      artist: nowPlaying.sub || 'WBAI 99.5 FM',
      album: 'WBAI Archive',
      artwork: artworkFor(nowPlaying.photo)
    });
    setHandler('play', function(){ audio.play().catch(function(){}); });
    setHandler('pause', function(){ audio.pause(); });
    setHandler('stop', function(){ audio.pause(); });
    setHandler('seekbackward', function(d){ seekBy(-((d && d.seekOffset) || SKIP_SECONDS)); });
    setHandler('seekforward', function(d){ seekBy((d && d.seekOffset) || SKIP_SECONDS); });
    setHandler('seekto', function(d){
      if(!d || !isFinite(d.seekTime)) return;
      if(d.fastSeek && audio.fastSeek){ audio.fastSeek(d.seekTime); }
      else { audio.currentTime = d.seekTime; }
      updatePositionState();
    });
    setHandler('previoustrack', function(){ playNeighbor(-1); });
    setHandler('nexttrack', function(){ playNeighbor(1); });
    setPlaybackState(audio.paused ? 'paused' : 'playing');
    lastPositionSync = 0;
    updatePositionState();
  }

  // ---- live session ----
  // A live stream can't be seeked or stepped through, so those handlers are
  // explicitly nulled — otherwise the OS keeps offering the archive's controls.
  function activateLiveSession(){
    if(!hasMediaSession) return;
    mediaMode = 'live';
    refreshLiveMetadata();
    setHandler('play', function(){ if(!liveWanted) startLive(); });
    setHandler('pause', function(){ stopLive(); });
    setHandler('stop', function(){ stopLive(); });
    setHandler('seekbackward', null);
    setHandler('seekforward', null);
    setHandler('seekto', null);
    setHandler('previoustrack', null);
    setHandler('nexttrack', null);
    setPlaybackState('playing');
    updatePositionState();
  }

  // Called again every time the now-playing poll reports a new show, so the lock
  // screen re-titles itself mid-listen as the schedule rolls over.
  var liveMeta = { title:'WBAI 99.5 FM', artist:'Free Speech Radio · Live', photo:'' };
  function refreshLiveMetadata(){
    if(!hasMediaSession || mediaMode !== 'live') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: liveMeta.title,
      artist: liveMeta.artist,
      album: 'WBAI 99.5 FM · Live',
      artwork: artworkFor(liveMeta.photo)
    });
  }

  // Real on-air/up-next metadata, from confessor2.wbai.org's now-playing endpoint.
  // That endpoint doesn't send CORS headers, so a live browser fetch will usually
  // be blocked; this snapshot (captured 2026-07-23) is the fallback either way.
  var NOWPLAYING_SNAPSHOT = {
    current:{name:'Joy of Resistance', dj:'Fran Luck and Maretta Short', start:'11:00 AM', end:'12:00 PM', photo:'/pix/joyrapeforum_med_191.jpg'},
    next:{name:'Frontline Voices', start:'12:00 PM', end:'1:00 PM'}
  };
  function renderNowPlaying(cur, nxt, isLive){
    liveCurrent = cur;
    liveNext = nxt;
    liveIsLive = isLive;

    // repaint the modal in place (whether open or not) so it is current on open
    // and re-titles itself if the schedule rolls over while it is up
    paintLivePlayer();
    if(barMode === 'live') paintLiveBar();

    // keep the OS lock screen in step with the schedule
    liveMeta.title = cur.name;
    liveMeta.artist = (cur.dj ? cur.dj + ' · ' : '') + 'WBAI 99.5 FM · On Air';
    liveMeta.photo = cur.photo || '';
    refreshLiveMetadata();
  }

  function applyNowPlayingSnapshot(){
    renderNowPlaying(NOWPLAYING_SNAPSHOT.current, NOWPLAYING_SNAPSHOT.next, false);
  }

  function fetchNowPlaying(){
    fetch('/api/nowplaying', {cache:'no-store'})
      .then(function(r){ return r.json(); })
      .then(function(data){
        if(data && data.current && data.current.name){
          renderNowPlaying(data.current, data.next || {name:'',start:''}, true);
        }
      })
      .catch(function(){ /* keep whatever is currently shown */ });
  }

  applyNowPlayingSnapshot();
  fetchNowPlaying();
  setInterval(fetchNowPlaying, 15000);

  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Elapsed time, in the largest unit that still says something. "today" was
  // throwing away real precision: rows carry a full timestamp, not a date —
  // 21:00, 18:30, 17:42:48 — and on a station that airs a couple of dozen
  // programmes a day, "2h ago" and "today" are very different answers to "is
  // there anything new for me".
  //
  // Clamped at zero because both inputs are compared against the *browser's*
  // clock: `updated` is stamped by the server, and a device a few minutes fast
  // would otherwise render "in 3 minutes".
  function relTime(ts){
    var secs = Math.max(0, Math.round(Date.now()/1000 - ts));
    if(secs < 60)      return 'just now';
    var mins = Math.round(secs/60);
    if(mins < 60)      return mins + 'm ago';
    var hrs = Math.round(mins/60);
    if(hrs < 24)       return hrs + 'h ago';
    var days = Math.round(hrs/24);
    if(days < 7)       return days === 1 ? 'yesterday' : days + 'd ago';
    var d = new Date(ts*1000);
    return MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  function timeOfDay(d){
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h < 12 ? 'AM' : 'PM';
    h = h % 12; if(h === 0) h = 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  // When the SERVER last read upstream. Set from /api/archive on load and from
  // every /api/archive/head poll, both of which already carry it — the client
  // was fetching this and throwing it away. Note it is the scrape time, not the
  // poll time: if the server is serving a stale cache this correctly reports
  // the older figure rather than flattering itself.
  var archiveUpdated = 0;

  // Which of the two facts the strip is currently showing. The other one used
  // to live only in the `title`, which is unreachable on a phone — there is no
  // hover — so the label is a button and a tap swaps them. Same control on
  // desktop, where the tooltip still carries both at once.
  var clockMode = 'show';   // 'show' | 'checked'

  // Both spans are written every time; styles.css picks which one shows.
  function setClock(){
    var longEl = clockEl.querySelector('.clock-long');
    var shortEl = clockEl.querySelector('.clock-short');
    if(!longEl || !shortEl) return;
    if(!latestDt){
      longEl.textContent = shortEl.textContent = '';
      clockEl.removeAttribute('title');
      clockEl.disabled = true;
      return;
    }

    var d = new Date(latestDt * 1000);
    var stamp = MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + timeOfDay(d);

    // Nothing to swap to if the server never told us when it last looked (the
    // shipped fallback snapshot carries no timestamp), so don't offer a toggle
    // that would do nothing.
    var canSwap = !!archiveUpdated;
    clockEl.disabled = !canSwap;
    if(!canSwap) clockMode = 'show';

    if(clockMode === 'checked'){
      longEl.textContent = 'Archive checked ' + relTime(archiveUpdated/1000);
      shortEl.textContent = 'Checked · ' + relTime(archiveUpdated/1000);
    } else {
      // Wide screens get the wall-clock time of the newest broadcast; phones get
      // the same fact as an interval, which is both shorter and the thing you
      // actually want to know.
      longEl.textContent = 'Latest show ' + stamp;
      shortEl.textContent = 'Latest show · ' + relTime(latestDt);
    }

    // Deliberately two separate facts — the newest show and when we last looked
    // are not the same thing, and collapsing them into one "updated" figure is
    // how you end up claiming a quiet night means a broken feed.
    var tip = 'Newest broadcast: ' + stamp + ', ' + relTime(latestDt);
    if(canSwap){
      tip += '\nArchive checked ' + relTime(archiveUpdated/1000);
      tip += '\n(tap to swap)';
    }
    clockEl.title = tip;
  }

  clockEl.addEventListener('click', function(){
    if(clockEl.disabled) return;
    clockMode = clockMode === 'show' ? 'checked' : 'show';
    setClock();
  });

  // Keeps "2h ago" honest on a tab left open. Cheap: two textContent writes a
  // minute, and only when the rendered string would actually change — which is
  // why the guard tracks BOTH facts, not just the one currently on screen.
  var clockTick = '';
  setInterval(function(){
    if(!latestDt) return;
    var next = relTime(latestDt) + '|' + (archiveUpdated ? relTime(archiveUpdated/1000) : '');
    if(next === clockTick) return;
    clockTick = next;
    setClock();
  }, 60000);

  // `updated` is the server's scrape timestamp, carried by both /api/archive and
  // /api/archive/head. Optional — the shipped fallback snapshot has no such
  // thing, and a missing value must leave the last known one alone rather than
  // zeroing it.
  function ingest(list, updated){
    rows = list;
    if(updated) archiveUpdated = updated;
    latestDt = rows.reduce(function(max,r){ return Math.max(max, r.dt); }, 0);
    archiveSig = rows.length + ':' + latestDt;
    render();
    setClock();
    openDeepLink();
  }

  // A `?show=` link can only be honoured once the rows exist, and only if the
  // episode is still inside its retention window — see the note in index.html.
  var deepLinkDone = false;
  function openDeepLink(){
    if(deepLinkDone) return;
    deepLinkDone = true;
    var id = param('show');
    if(!id) return;
    if(!rowById(id)){
      var notice = document.getElementById('linkNotice');
      if(notice) notice.hidden = false;
      syncUrl();                 // drop the dead id so a reload is clean
      return;
    }
    // Rewrite the landing entry to the plain listing first, so the sheet's own
    // entry sits on top of it and Back closes the sheet instead of leaving.
    if(canHistory){ try { history.replaceState(null, '', urlFor(null)); } catch(e){} }
    openSheetById(id);
  }

  function loadArchive(){
    setCount('Loading shows…', false);
    fetch('/api/archive', {cache:'no-store'})
      .then(function(r){ if(!r.ok) throw new Error('archive '+r.status); return r.json(); })
      .then(function(data){ ingest(data.shows || [], data.updated); })
      .catch(function(){
        // fall back to the shipped snapshot if the live scrape is unavailable
        fetch('/data/shows-fallback.json', {cache:'no-store'})
          .then(function(r){ return r.json(); })
          .then(function(data){ ingest(data.shows || [], data.updated); })
          .catch(function(){ loadingEl.hidden = true; setCount('Could not load the archive.', false); emptyEl.hidden = false; });
      });
  }

  // ---------------- Freshness poll + refresh pill ----------------
  // The listing is fetched once at load, so a tab left open all day would sit on
  // a frozen archive. Rather than re-render under the user (which would move the
  // list while they read, or while a show is playing), poll the cheap
  // /api/archive/head probe and let *them* pull the update in.
  //
  // Upstream is scraped at most every 10 min server-side, so a 5-minute poll of
  // a ~60-byte response is the cheapest thing that never lags the source by more
  // than one cache window.
  var FRESH_POLL_MS = 5 * 60 * 1000;
  var archiveSig = '';        // count:latestDt of what is currently rendered
  var pendingSig = '';        // signature the pill is offering, if shown
  var refreshBusy = false;
  var lastFreshCheck = 0;
  var refreshBtn = document.getElementById('refreshBtn');
  var refreshBtnText = document.getElementById('refreshBtnText');

  function showRefreshPill(sig, count){
    if(pendingSig === sig) return;
    pendingSig = sig;
    var added = count - rows.length;
    refreshBtnText.textContent = added > 0
      ? (added === 1 ? '1 new show' : added + ' new shows')
      : 'Archive updated';
    refreshBtn.setAttribute('aria-label', refreshBtnText.textContent + ' — refresh the listing');
    refreshBtn.hidden = false;
  }

  function hideRefreshPill(){
    pendingSig = '';
    refreshBtn.hidden = true;
    refreshBtn.classList.remove('busy');
    refreshBtn.disabled = false;
  }

  function checkFreshness(){
    if(!archiveSig || refreshBusy) return;         // nothing loaded yet, or mid-refresh
    if(document.hidden) return;                    // don't poll a backgrounded tab
    lastFreshCheck = Date.now();
    fetch('/api/archive/head', {cache:'no-store'})
      .then(function(r){ if(!r.ok) throw new Error('head '+r.status); return r.json(); })
      .then(function(d){
        if(!d || !d.count) return;
        // Record how fresh the SERVER's copy is even when nothing changed — that
        // is the poll's other, quieter answer, and it costs nothing to keep.
        // NB d.latest is UPSTREAM's newest show, not ours: it must never feed
        // the "Latest show" label, which has to describe the list actually on
        // screen. The pill is what offers the newer one.
        if(d.updated){ archiveUpdated = d.updated; setClock(); }
        var sig = d.count + ':' + d.latest;
        if(sig !== archiveSig) showRefreshPill(sig, d.count);
      })
      .catch(function(){ /* transient; the next poll tries again */ });
  }

  // Swap the new listing in without a page reload: playback, the open sheet and
  // the scroll position all survive, and the paging depth is restored so someone
  // deep in the list isn't thrown back to the first page.
  function refreshArchive(){
    if(refreshBusy) return;
    refreshBusy = true;
    refreshBtn.classList.add('busy');
    refreshBtn.disabled = true;
    var keepShown = shown;
    var keepScroll = window.pageYOffset;
    fetch('/api/archive', {cache:'no-store'})
      .then(function(r){ if(!r.ok) throw new Error('archive '+r.status); return r.json(); })
      .then(function(data){
        ingest(data.shows || [], data.updated);
        while(shown < keepShown && shown < filtered.length) showMore();
        window.scrollTo(0, Math.min(keepScroll, Math.max(0, document.body.scrollHeight - window.innerHeight)));
        hideRefreshPill();
      })
      .catch(function(){
        // leave the pill up so the user can try again
        refreshBtn.classList.remove('busy');
        refreshBtn.disabled = false;
      })
      .then(function(){ refreshBusy = false; lastFreshCheck = Date.now(); });
  }

  refreshBtn.addEventListener('click', refreshArchive);
  setInterval(checkFreshness, FRESH_POLL_MS);
  // Coming back to a tab that has been parked for a while is exactly when the
  // listing is most likely stale, so check on return rather than waiting out the
  // rest of the interval.
  document.addEventListener('visibilitychange', function(){
    if(!document.hidden && Date.now() - lastFreshCheck > 60000) checkFreshness();
  });

  // ---------------- Show info sheet ----------------
  // Two sources feed it: /api/programs (wbai.org's program directory — host,
  // description and links for the whole schedule) and /api/showinfo (the on-air
  // feed's richer record for shows that have rotated through it). Anything
  // neither source knows is left out of the sheet rather than rendered empty.
  var showInfo = {};
  var programs = null;          // wbai.org program directory, keyed by normalised title
  var programsPromise = null;
  var sheet = document.getElementById('showSheet');
  var sheetScrim = document.getElementById('sheetScrim');
  var sheetClose = document.getElementById('sheetClose');
  var sheetBody = document.getElementById('sheetBody');
  var sheetFoot = document.getElementById('sheetFoot');
  var sheetReturnFocus = null;
  var sheetRowId = null;        // which archive row the sheet is currently showing
  var sheetMp3 = null;

  // Artwork lightbox: layered above the open sheet so a listener can tap the show
  // art for a full-size look. Opens from within the sheet only.
  var lightbox = document.getElementById('artLightbox');
  var lightboxImg = document.getElementById('lightboxImg');
  var lightboxClose = document.getElementById('lightboxClose');
  var lightboxReturnFocus = null;
  function lightboxOpen(){ return lightbox.classList.contains('show'); }
  function openLightbox(src, trigger){
    if(!src) return;
    lightboxReturnFocus = trigger || document.activeElement;
    lightboxImg.src = src;
    lightbox.classList.add('show');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lightbox-open');
    refreshOverlayState();
    lightboxClose.focus();
  }
  function closeLightbox(){
    if(!lightboxOpen()) return;
    lightbox.classList.remove('show');
    lightbox.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-open');
    lightboxImg.removeAttribute('src');
    refreshOverlayState();
    if(lightboxReturnFocus && lightboxReturnFocus.focus) lightboxReturnFocus.focus();
    lightboxReturnFocus = null;
  }
  lightboxClose.addEventListener('click', closeLightbox);
  // tapping the backdrop (anywhere but the image) closes it too
  lightbox.addEventListener('click', function(e){
    if(e.target === lightboxImg) return;
    closeLightbox();
  });

  // ---------------- Donate modal ----------------
  // The Donate button embeds WBAI's real donate page in an iframe so the flow
  // never leaves the site. Same scrim/dialog/focus-trap/inert lifecycle as the
  // live player. The iframe src is set on first open so the page isn't fetched
  // until someone actually wants to donate.
  var DONATE_URL = 'https://docs.pacifica.org/wbai/donate/';
  var donateBtn = document.getElementById('donateBtn');
  var donateModal = document.getElementById('donateModal');
  var donateScrim = document.getElementById('donateScrim');
  var donateClose = document.getElementById('donateClose');
  var donateFrame = document.getElementById('donateFrame');
  var donateReturnFocus = null;
  function donateOpen(){ return donateModal.classList.contains('show'); }
  function openDonate(){
    if(donateOpen()) return;
    donateReturnFocus = document.activeElement;
    if(!donateFrame.src) donateFrame.src = DONATE_URL;   // lazy: load on first open
    donateScrim.classList.add('show');
    donateModal.classList.add('show');
    donateModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('donate-open');
    refreshOverlayState();
    donateClose.focus();
    document.addEventListener('keydown', onDonateKey);
  }
  function closeDonate(){
    if(!donateOpen()) return;
    donateScrim.classList.remove('show');
    donateModal.classList.remove('show');
    donateModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('donate-open');
    document.removeEventListener('keydown', onDonateKey);
    refreshOverlayState();
    if(donateReturnFocus && donateReturnFocus.focus) donateReturnFocus.focus();
    donateReturnFocus = null;
  }
  // Only one focusable control lives in the modal chrome (the iframe manages its
  // own internal focus), so trap Tab on the close button and let Escape close.
  function onDonateKey(e){
    if(e.key === 'Escape'){ e.preventDefault(); closeDonate(); }
    else if(e.key === 'Tab'){ e.preventDefault(); donateClose.focus(); }
  }
  if(donateBtn) donateBtn.addEventListener('click', openDonate);
  donateClose.addEventListener('click', closeDonate);
  donateScrim.addEventListener('click', closeDonate);

  function fetchShowInfo(){
    fetch('/api/showinfo', {cache:'no-store'})
      .then(function(r){ return r.json(); })
      .then(function(data){ if(data && data.shows) showInfo = data.shows; })
      .catch(function(){ /* non-fatal: the sheet just has less to show */ });
  }

  // The program directory is a few hundred KB of prose, so it is fetched the
  // first time someone opens a sheet rather than on page load.
  function ensurePrograms(){
    if(programsPromise) return programsPromise;
    programsPromise = fetch('/api/programs')
      .then(function(r){ return r.json(); })
      .then(function(data){ programs = (data && data.programs) || {}; })
      .catch(function(){ programs = {}; });
    return programsPromise;
  }

  // Descriptions for shows the on-air harvest has never met are resolved one at
  // a time, when someone actually opens that show's sheet. The sheet paints
  // immediately from whatever we already hold and fills in when this lands, so a
  // slow or failed lookup costs nothing — it just leaves the sheet as it was.
  var detailAsked = {};
  function ensureShowDetail(altid){
    if(!altid || detailAsked[altid]) return;
    var have = showInfo[altid];
    if(have && have.desc) return;          // already have what the sheet needs
    detailAsked[altid] = true;
    fetch('/api/showinfo/' + encodeURIComponent(altid), {cache:'no-store'})
      .then(function(r){ return r.json(); })
      .then(function(d){
        if(!d || !d.info) return;
        showInfo[altid] = d.info;
        // repaint only if this is still the sheet on screen
        var same = rowById(sheetRowId);
        if(same && same.sho === altid && sheet.classList.contains('show')) paintSheet(same);
      })
      .catch(function(){ /* non-fatal: the sheet keeps what it had */ });
  }

  // Same normalisation the server keys the directory with: the archive and
  // wbai.org share nothing but the show's name.
  function normTitle(s){
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // The two systems name the same show differently often enough that an exact
  // key match only covers about three quarters of the archive: "Black Agenda
  // Report" vs "Black Agenda Radio", "BreakThrough News" vs "BreakThrough News
  // Radio", "Capitalism Race and Democracy" vs "Capitalism, Race & Democracy".
  // So matching falls through three widening tiers, all of them still anchored
  // on the show's actual words.
  var FILLER = {the:1, a:1, an:1, of:1, and:1, with:1, show:1, radio:1, report:1,
                program:1, hour:1, live:1, rebroadcast:1, re:1, broadcast:1};
  function coreKey(key){
    var out = key.split(' ').filter(function(w){ return w && !FILLER[w]; });
    return out.sort().join(' ');
  }
  function leadStrip(key){          // "the poet and the poem" -> "poet and the poem"
    var w = key.split(' ');
    while(w.length > 1 && FILLER[w[0]]) w.shift();
    return w.join(' ');
  }
  var programIndex = null;
  function buildProgramIndex(){
    programIndex = [];
    for(var k in programs){
      programIndex.push({
        key: k,
        lead: leadStrip(k),
        squash: k.replace(/ /g, ''),   // "covertaction bulletin" vs "covert action bulletin"
        core: coreKey(k),
        tokens: k.split(' '),
        coreTokens: coreKey(k).split(' ')
      });
    }
  }
  function dice(a, b){
    var shared = a.filter(function(w){ return b.indexOf(w) !== -1; }).length;
    return (2 * shared) / (a.length + b.length);
  }
  function programFor(title){
    if(!programs) return null;
    if(!programIndex) buildProgramIndex();
    var key = normTitle(title);
    if(programs[key]) return programs[key];

    var lead = leadStrip(key), squash = key.replace(/ /g, '');
    var core = coreKey(key), tokens = key.split(' '), coreTokens = core.split(' ');
    var best = null, bestScore = 0;
    for(var i=0; i<programIndex.length; i++){
      var p = programIndex[i], score;
      if(p.squash === squash) score = 0.99;
      // one title is the other plus a qualifier ("… Re-broadcast", "… Friday")
      else if(p.lead.length >= 8 && (lead.indexOf(p.lead+' ') === 0 || p.lead.indexOf(lead+' ') === 0)) score = 0.95;
      // same words once "show"/"radio"/"the" and friends are set aside
      else if(core && p.core === core) score = 0.9;
      else score = Math.max(dice(tokens, p.tokens), dice(coreTokens, p.coreTokens));
      if(score > bestScore){ bestScore = score; best = programs[p.key]; }
    }
    return bestScore >= 0.72 ? best : null;
  }

  // Upstream stores these as free text, so only absolute http(s) links (or a
  // bare domain we can safely promote to one) ever become an href.
  function safeUrl(u){
    var s = String(u || '').trim();
    if(!s) return '';
    if(/^https?:\/\//i.test(s)) return s;
    if(/^[\w.-]+\.[a-z]{2,}([\/?#]|$)/i.test(s)) return 'https://' + s;
    return '';
  }

  // Upstream spells the weekday and month out in full ("Friday, July 24, 2026"),
  // which is most of a line on its own. Unknown words are left alone.
  var LONG_NAMES = {
    Sunday:'Sun', Monday:'Mon', Tuesday:'Tue', Wednesday:'Wed',
    Thursday:'Thu', Friday:'Fri', Saturday:'Sat',
    January:'Jan', February:'Feb', March:'Mar', April:'Apr', May:'May',
    June:'Jun', July:'Jul', August:'Aug', September:'Sep', October:'Oct',
    November:'Nov', December:'Dec'
  };
  function shortDateText(s){
    return String(s || '').replace(/[A-Z][a-z]+/g, function(w){
      return LONG_NAMES[w] || w;
    });
  }
  function sheetLink(href, icon, label){
    return sheetLinkHtml(href, icon, esc(label));
  }
  // Same pill, but the caller supplies its own (already-escaped) label markup —
  // used where a phone shows a shorter wording than the desktop sheet does.
  function sheetLinkHtml(href, icon, labelHtml){
    return '<a class="sheet-link" href="'+esc(href)+'" target="_blank" rel="noopener noreferrer">'+icon+labelHtml+'</a>';
  }

  function sheetHtml(r){
    var info = showInfo[r.sho] || {};
    var prog = programFor(r.title) || {};
    var c = CAT_BY_KEY[r.cat] || {label:'', color:'var(--accent)'};
    // the archive row is most specific, then the on-air feed, then the directory
    var host = r.host || info.dj || prog.host || '';
    var desc = info.desc || prog.desc || info.shortdesc || '';
    var photo = r.photo || info.photo || '';
    var dparts = splitDateText(r.dateText);
    var subLine = c.label + (host ? ' · with '+host : '');
    var isLoading = (loadingMp3===r.mp3);
    var isPlaying = (nowPlaying.mp3===r.mp3 && !audio.paused && !audio.ended && !isLoading);

    // One wrapping row rather than three stacked label/value pairs. A long title
    // plus a clamped description used to push availability under the pinned
    // footer, where it read as missing rather than as scrolled-away. The
    // retention pill says "59 days left" on its own, so it needs no label —
    // that's a whole row saved. Empty values are still dropped entirely.
    function fact(label, value){
      return value ? '<span class="fact"><span class="fact-k">'+label+'</span>'+value+'</span>' : '';
    }
    var facts =
      fact('Aired', dparts.date ? esc(shortDateText(dparts.date))+(dparts.time ? ' <span class="mono">'+esc(dparts.time)+'</span>' : '') : '')+
      fact('Length', r.length ? '<span class="mono">'+esc(r.length)+'</span>' : '')+
      '<span class="retention '+retentionClass(r.daysLeft)+'">'+retentionLabel(r.daysLeft)+'</span>';

    var links = '';
    if(showRss(r)) links += sheetLink(RSS_BASE+encodeURIComponent(r.sho), svgRss(), 'RSS feed');
    var site = safeUrl(info.url || prog.url);
    // Phones drop the verb: four pills have to share a narrow row, and "Website"
    // is unambiguous next to a link glyph. CSS picks which span is shown.
    if(site) links += sheetLinkHtml(site, svgLink(),
      '<span class="link-wide">Show website</span><span class="link-narrow">Website</span>');
    var fb = safeUrl(info.facebook || prog.facebook);
    if(fb) links += sheetLink(fb, svgFacebook(), 'Facebook');
    var tw = safeUrl(prog.twitter);
    if(tw) links += sheetLink(tw, svgLink(), 'Twitter');
    // Rendered only where the OS can actually take it, in keeping with the
    // sheet's rule that nothing is shown as an inert placeholder.
    //
    // Its word is in a .link-wide span so phones can drop it (CSS) and leave the
    // glyph alone — four pills don't fit one row otherwise, and Share is the only
    // one that can lose its label: the share glyph is unambiguous, while Website
    // and Twitter are both drawn with svgLink() and are told apart by wording.
    // Hence the aria-label, which is the accessible name once the span is hidden.
    if(navigator.share) links += '<button class="sheet-link sheet-share" type="button" aria-label="Share">'+
      svgShare()+'<span class="link-wide">Share</span></button>';

    var play = r.mp3
      ? '<button class="sheet-play play-btn'+(isPlaying?' playing':'')+(isLoading?' loading':'')+'" type="button" '+
        playAttrs(r, subLine, photo, isLoading, isPlaying)+'>'+glyph(isLoading, isPlaying)+
        '<span class="play-label">'+esc(playLabelFor(r.mp3, isLoading, isPlaying))+'</span></button>'
      : '';

    // Rendered always, revealed by syncSheetRestart() only while this episode has
    // a saved position — so pausing with the sheet open makes it appear in place.
    var restart = r.mp3
      ? '<button class="sheet-restart" id="sheetRestart" type="button" hidden>Start over</button>'
      : '';

    // Mirrors the docked player's scrubber; revealed by syncSheetScrub() once
    // this episode is the one loaded in the audio element.
    var scrub = r.mp3
      ? '<div class="player-scrub sheet-scrub" id="sheetScrub" hidden>'+
          '<span class="player-time" id="sheetCurrent">0:00</span>'+
          '<input class="player-range" id="sheetRange" type="range" min="0" max="0" value="0" step="1" aria-label="Seek within '+esc(r.title)+'" disabled>'+
          '<span class="player-time" id="sheetDuration">0:00</span>'+
        '</div>'
      : '';

    return {
      body:
        '<div class="sheet-head">'+
          // With art, the tile is a real control that opens the lightbox for a
          // closer look. With none, it stays a decorative (aria-hidden) span.
          (photo
            ? '<button type="button" class="sheet-art sheet-art-zoom" data-photo="'+esc(photo)+'" aria-label="View larger artwork for '+esc(r.title)+'">'+
                '<img alt="" src="'+esc(photo)+'">'+
                '<span class="sheet-art-zoom-badge" aria-hidden="true">'+
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>'+
                '</span>'+
              '</button>'
            : '<span class="sheet-art" aria-hidden="true"></span>')+
          '<div class="sheet-titles">'+
            (c.label ? '<span class="sheet-eyebrow">'+catIcon(r.cat)+esc(c.label)+'</span>' : '')+
            '<h2 id="sheetTitle">'+esc(r.title)+'</h2>'+
            (host ? '<div class="sheet-host">with '+esc(host)+'</div>' : '')+
          '</div>'+
        '</div>'+
        (desc ? '<div class="sheet-desc-wrap"><p class="sheet-desc" id="sheetDesc">'+esc(desc)+'</p></div>' : '')+
        '<div class="sheet-facts">'+facts+'</div>',
      // pinned: the controls must never scroll out of reach behind a long
      // description. Secondary links sit in their own row *above* Play, so the
      // primary control keeps a predictable position however many links a show
      // happens to have — a well-documented show used to push Play onto line two.
      foot:
        (links ? '<div class="sheet-links">'+links+'</div>' : '') +
        (play ? '<div class="sheet-actions">'+play+restart+'</div>' : '') +
        scrub
    };
  }

  // Long descriptions (Democracy Now!'s runs to a dozen paragraphs) are clamped
  // to a few lines with a toggle, so the sheet opens compact either way.
  function setupDescClamp(){
    var p = document.getElementById('sheetDesc');
    if(!p) return;
    var wrap = p.parentNode;
    // clamped by CSS on paint; only offer the toggle if it actually overflows
    if(p.scrollHeight - p.clientHeight < 4) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'desc-toggle';
    btn.textContent = 'Show more';
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function(){
      var open = wrap.classList.toggle('expanded');
      btn.textContent = open ? 'Show less' : 'Show more';
      btn.setAttribute('aria-expanded', String(open));
    });
    wrap.appendChild(btn);
  }

  // The sheet's scrubber only makes sense for the episode currently loaded in
  // the audio element, so it is hidden until that is this sheet's episode.
  function syncSheetScrub(){
    var box = document.getElementById('sheetScrub');
    if(!box) return;
    var active = !!sheetMp3 && nowPlaying.mp3 === sheetMp3;
    box.hidden = !active;
    if(active && !seeking){ applyDuration(); paintScrubTime(); }
  }

  // "Start over" is only an offer when there is somewhere to start over *from*.
  function syncSheetRestart(){
    var btn = document.getElementById('sheetRestart');
    if(!btn) return;
    btn.hidden = !(sheetMp3 && resumeFor(sheetMp3) > 0);
  }

  // ---- The sheet's close button makes the same promise the live player's does
  // (see paintLiveCloseBtn): closing has never stopped archive audio either, so
  // whenever the docked bar is holding *this* episode the control says
  // chevron-down instead of ✕.
  //
  // "This episode", not "anything is playing": the sheet can be open on show A
  // while show B plays, and closing it really does leave A behind — an ✕ is the
  // truth there. barMode is checked because a live takeover can leave a paused
  // archive track in nowPlaying while the bar shows the stream.
  function sheetWillMinimize(){
    if(!sheetMp3) return false;
    if(sheetMp3 === loadingMp3) return true;      // connecting hands over just the same
    return barMode === 'archive' && !playerBar.hidden && sheetMp3 === nowPlaying.mp3;
  }
  function paintSheetCloseBtn(){
    if(!sheetClose) return;        // called from updatePlayButtons() before wiring
    var min = sheetWillMinimize();
    sheetClose.classList.toggle('minimize', min);
    sheetClose.setAttribute('aria-label', min
      ? 'Minimize — this episode stays in the player below'
      : 'Close show info');
    sheetClose.setAttribute('title', min ? 'Minimize' : 'Close');
  }

  // Reads the sheet's own Play button rather than the archive row: the sheet
  // merges in a host from the on-air feed or the directory, so its data-sub is
  // the richer line, and this keeps the two controls describing one track.
  function restartSheetEpisode(){
    var btn = sheetFoot.querySelector('.sheet-play');
    if(!btn || !btn.dataset.mp3) return;
    // already loaded: rewind in place rather than re-buffering the whole file
    if(nowPlaying.mp3 === btn.dataset.mp3){
      startOver();
      if(audio.paused) audio.play().catch(function(){});
      return;
    }
    playTrack(btn.dataset.mp3, btn.dataset.title, btn.dataset.sub, btn.dataset.photo, true);
  }

  function rowById(id){
    for(var i=0; i<rows.length; i++){
      if(String(rows[i].id) === String(id)) return rows[i];
    }
    return null;
  }
  function rowByMp3(mp3){
    for(var i=0; i<rows.length; i++){
      if(rows[i].mp3 && rows[i].mp3 === mp3) return rows[i];
    }
    return null;
  }

  function paintSheet(r){
    sheetRowId = r.id;
    sheetMp3 = r.mp3 || null;
    var parts = sheetHtml(r);
    sheetBody.innerHTML = parts.body;
    sheetFoot.innerHTML = parts.foot;
    sheetBody.scrollTop = 0;
    setupDescClamp();
    bindRange(document.getElementById('sheetRange'));
    syncSheetScrub();
    syncSheetRestart();
    paintSheetCloseBtn();   // sheetMp3 just changed, so the promise may have too
  }

  // `fromHistory` marks an open that a popstate is already accounting for, so it
  // must not push an entry of its own.
  function openSheetById(id, trigger, fromHistory){
    var r = rowById(id);
    if(!r) return;
    // One history entry per *opening*, not per sheet: swapping from one show to
    // another with the sheet already up replaces the entry, so Back always
    // returns to the listing rather than walking back through shows.
    var wasOpen = sheet.classList.contains('show');
    paintSheet(r);
    if(canHistory && !fromHistory){
      try {
        history[wasOpen ? 'replaceState' : 'pushState']({sheetId:r.id}, '', urlFor(r.id));
      } catch(e){}
    }
    sheetReturnFocus = trigger || document.activeElement;
    endMinimize();     // re-opened mid-collapse: drop the transform, it wins
    sheet.classList.add('show');
    sheetScrim.classList.add('show');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheet-open');
    refreshOverlayState();
    sheetClose.focus();
    document.addEventListener('keydown', onSheetKey);

    // the directory arrives on first open; repaint if this sheet is still up
    if(!programs){
      ensurePrograms().then(function(){
        var same = rowById(sheetRowId);
        if(same && sheet.classList.contains('show')) paintSheet(same);
      });
    }
    // and the per-show record, for anything neither source already describes
    ensureShowDetail(r.sho);
  }

  // Closing from the UI goes through history so the entry pushed on open is
  // consumed; popstate then calls dismissSheet() to do the actual work. Without
  // this, closing by button would leave a dead entry that Back would replay.
  function closeSheet(){
    if(!sheet.classList.contains('show')) return;
    if(canHistory && history.state && history.state.sheetId){ history.back(); return; }
    dismissSheet();
  }

  function dismissSheet(){
    if(!sheet.classList.contains('show')) return;
    // The card can only collapse toward a bar that is on screen to be measured.
    if(sheetWillMinimize() && !playerBar.hidden) runMinimize(sheet);
    closeLightbox();   // never leave the artwork overlay stranded over a closed sheet
    sheet.classList.remove('show');
    sheetScrim.classList.remove('show');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sheet-open');
    document.removeEventListener('keydown', onSheetKey);
    refreshOverlayState();
    if(sheetReturnFocus && sheetReturnFocus.focus) sheetReturnFocus.focus();
    sheetReturnFocus = null;
    sheetRowId = null;
    sheetMp3 = null;
    syncUrl();
  }

  // Back/forward: the entry either names a sheet or it doesn't.
  window.addEventListener('popstate', function(){
    var id = (history.state && history.state.sheetId) || param('show');
    if(id && rowById(id)) openSheetById(id, null, true);
    else dismissSheet();
  });

  function onSheetKey(e){
    // The lightbox layers above the sheet, so it gets first refusal on both keys:
    // Escape closes the image (not the sheet), and Tab is trapped on its one control.
    if(lightboxOpen()){
      if(e.key === 'Escape'){ e.preventDefault(); closeLightbox(); }
      else if(e.key === 'Tab'){ e.preventDefault(); lightboxClose.focus(); }
      return;
    }
    if(e.key === 'Escape'){ closeSheet(); return; }
    if(e.key !== 'Tab') return;
    // keep keyboard focus inside the dialog while it is open
    var f = sheet.querySelectorAll('a[href], button:not([disabled])');
    if(!f.length) return;
    var first = f[0], last = f[f.length-1];
    if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
    else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
  }

  sheetClose.addEventListener('click', closeSheet);
  sheetScrim.addEventListener('click', closeSheet);
  // bound on the dialog, so it covers the pinned footer as well as the body
  sheet.addEventListener('click', function(e){
    var art = e.target.closest('.sheet-art-zoom');
    if(art){ openLightbox(art.dataset.photo, art); return; }
    var btn = e.target.closest('.sheet-play');
    if(btn){ togglePlayFrom(btn); return; }
    if(e.target.closest('.sheet-restart')){ restartSheetEpisode(); return; }
    if(e.target.closest('.sheet-share')) shareSheet();
  });

  // Deliberately a bare `?show=` link, without whatever category or search the
  // sharer happened to have applied — the recipient wants the episode, not the
  // sharer's filters. It stays valid only until the episode's retention window
  // closes; openDeepLink() handles the other side of that.
  function shareSheet(){
    var r = sheetRowId && rowById(sheetRowId);
    if(!r || !navigator.share) return;
    navigator.share({
      title: r.title,
      text: r.title + ' — WBAI 99.5 FM Archive',
      url: location.origin + location.pathname + '?show=' + encodeURIComponent(r.id)
    }).catch(function(){ /* dismissed by the user, or no target chosen */ });
  }
  // artwork that 404s falls back to the station placeholder behind it
  sheetBody.addEventListener('error', function(e){
    if(e.target && e.target.tagName === 'IMG') e.target.classList.add('failed');
  }, true);

  fetchShowInfo();
  // slow poll: the harvest only gains an entry when the schedule rolls over
  setInterval(fetchShowInfo, 120000);

  // ---------------- Slide-out menu drawer ----------------
  (function(){
    var btn = document.getElementById('menuBtn');
    var panel = document.getElementById('menuPanel');
    var scrim = document.getElementById('menuScrim');
    var closeBtn = document.getElementById('menuClose');
    if(!btn || !panel || !scrim || !closeBtn) return;
    var lastFocus = null;

    function openMenu(){
      lastFocus = document.activeElement;
      panel.classList.add('show');
      scrim.classList.add('show');
      panel.setAttribute('aria-hidden', 'false');
      btn.setAttribute('aria-expanded', 'true');
      document.body.classList.add('menu-open');
      refreshOverlayState();
      closeBtn.focus();
      document.addEventListener('keydown', onKey);
    }
    function closeMenu(){
      panel.classList.remove('show');
      scrim.classList.remove('show');
      panel.setAttribute('aria-hidden', 'true');
      btn.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('menu-open');
      document.removeEventListener('keydown', onKey);
      refreshOverlayState();
      if(lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function onKey(e){
      if(e.key === 'Escape'){ closeMenu(); return; }
      if(e.key !== 'Tab') return;
      // keep keyboard focus inside the open drawer
      var f = panel.querySelectorAll('a[href], button:not([disabled])');
      if(!f.length) return;
      var first = f[0], last = f[f.length-1];
      if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }

    btn.addEventListener('click', openMenu);
    closeBtn.addEventListener('click', closeMenu);
    scrim.addEventListener('click', closeMenu);

    // The drawer's Donate item opens the same framed modal as the appbar pill,
    // so donating never leaves the app — the drawer slides out from under the
    // card as it comes up (z-index 300 vs 160, so the overlap is fine).
    //
    // Order matters: closeMenu() must run BEFORE openDonate(). closeMenu()
    // restores focus to the menu button, which would immediately steal it back
    // from the dialog if it ran second. Running it first also means the
    // activeElement openDonate() captures is that menu button, so closing the
    // modal lands focus on a control that is still on screen.
    var donateLink = document.getElementById('menuDonate');
    if(donateLink) donateLink.addEventListener('click', function(e){
      if(e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;  // let modified clicks use the href
      e.preventDefault();
      closeMenu();
      openDonate();
    });
  })();

  // ---------------- Hero copy: two lines on phones ----------------
  // Deliberately thinner than setupDescClamp(): that one measures overflow
  // because show descriptions vary from one line to a dozen paragraphs. This
  // copy is fixed, so the clamp is a pure CSS media query and JS owns only the
  // open/closed state. Nothing here runs on desktop except the listener.
  (function(){
    var wrap = document.getElementById('heroDescWrap');
    var btn = document.getElementById('heroMore');
    if(!wrap || !btn) return;
    btn.addEventListener('click', function(){
      var open = wrap.classList.toggle('expanded');
      btn.textContent = open ? 'less' : 'more';
      btn.setAttribute('aria-expanded', String(open));
    });
  })();

  // ---------------- Theme switch ----------------
  // The icon and the palette are pure CSS (see --sun in styles.css); everything
  // this block owns is the *choice*. theme-boot.js has already applied any saved
  // one before the first paint, so there is nothing to do on load but label the
  // button.
  (function(){
    var btn = document.getElementById('themeBtn');
    var T = window.WBAITheme;
    if(!btn || !T) return;   // boot script blocked (CSP/adblock) — leave the system theme alone

    var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: light)') : null;

    function label(){
      // Name the ACTION, not the state. The icon shows where you are; a button
      // announced as "Dark" while sitting in dark mode is the classic ambiguity.
      var next = T.active() === 'dark' ? 'light' : 'dark';
      btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
      btn.title = 'Switch to ' + next + ' theme';
    }

    btn.addEventListener('click', function(){
      var next = T.active() === 'dark' ? 'light' : 'dark';
      // First tap commits to an explicit preference and stops following the OS.
      // That is the intent — someone who reaches for this wants THIS device on
      // THIS theme, not a setting that flips under them at sunset.
      T.save(next);
      T.apply(next);
      label();
    });

    // Only relevant while still following the system, but harmless after: once a
    // preference is stored, active() ignores the OS and the label doesn't move.
    if(mq && mq.addEventListener) mq.addEventListener('change', label);
    else if(mq && mq.addListener) mq.addListener(label);

    label();
  })();

  // ---------------- Back to top ----------------
  // Appears once you are deep enough in the listing that scrolling back is a
  // chore, gets out of the way while you are moving, returns when you stop.
  //
  // The rule is DIRECTION-AWARE, and that is the whole feel of it. An upward
  // scroll already means "I'm heading back", so the button appears on that frame
  // instead of waiting out the idle timer; downward scrolling hides it; and the
  // timer only has to cover stopping mid-flight. 800ms reads as "it waited for
  // me" — the 1-2s that sounds right when you describe the behaviour out loud
  // reads as broken when you use it.
  //
  // Geometry — and in particular how it keeps its distance from the ✕ that ends
  // playback — is in styles.css under "Back to top".
  (function(){
    var btn = document.getElementById('toTop');
    if(!btn) return;
    var bar = document.getElementById('playerBar');
    var mainEl = document.getElementById('top');
    var root = document.documentElement;

    var IDLE_MS = 800;
    // 1.5 viewports rather than a flat 300px: under that, scrolling back up is
    // cheap and the button is just something in the way of the listing.
    function threshold(){ return window.innerHeight * 1.5; }
    function scrollY(){ return window.pageYOffset || root.scrollTop || 0; }

    var lastY = scrollY();
    var isShown = false;
    var idleTimer = 0;
    var frameQueued = false;
    var gliding = false;   // a click-driven scroll to the top is in flight

    function setShown(on){
      if(on === isShown) return;
      isShown = on;
      btn.setAttribute('data-show', on ? 'true' : 'false');
    }

    function measure(){
      var y = scrollY();
      var dy = y - lastY;
      lastY = y;

      // Our own glide: stay hidden for the whole trip, or the upward-scroll rule
      // below would instantly re-show the button we just dismissed and it would
      // ride the animation back up. Released early if the user grabs the page
      // mid-flight (see the input listeners), so this only has to notice arrival.
      if(gliding){
        if(y <= 2) gliding = false;
        return;
      }

      clearTimeout(idleTimer);
      if(y <= threshold()){
        // Not resting — arrived. No idle grace on the way out.
        setShown(false);
        return;
      }
      // The +/-2px deadband keeps sub-pixel and momentum-tail scroll events from
      // being read as a direction.
      if(dy < -2){ setShown(true); return; }   // heading up: no delay, that's the point
      if(dy > 2) setShown(false);              // heading down: get out of the way
      idleTimer = setTimeout(function(){ setShown(true); }, IDLE_MS);
    }

    function onScroll(){
      if(frameQueued) return;
      frameQueued = true;
      requestAnimationFrame(function(){ frameQueued = false; measure(); });
    }

    // These fire BEFORE the click below (pointerdown/touchstart precede click),
    // so pressing the button itself clears a stale flag and then sets a fresh
    // one — the ordering is load-bearing, don't reorder them into the click.
    function endGlide(){ gliding = false; }

    btn.addEventListener('click', function(){
      var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      // Past ~6 viewports a smooth scroll takes seconds and reads as a hang, so
      // it jumps instead. Under reduced motion it always jumps: a thirty-viewport
      // glide is precisely what that setting exists to prevent.
      var far = scrollY() > window.innerHeight * 6;
      // Focus follows the viewport or it doesn't count — otherwise a keyboard
      // user is left on row 340 looking at row 1. main is tabindex="-1" for this;
      // preventScroll stops focus() from jumping there itself and eating the
      // animation.
      if(mainEl){
        try{ mainEl.focus({ preventScroll: true }); }catch(e){ mainEl.focus(); }
      }
      gliding = true;
      setShown(false);
      // Belt and braces: if the glide is interrupted somewhere that fires no
      // input event, the flag must not strand the button hidden.
      setTimeout(endGlide, 1500);
      window.scrollTo({ top: 0, behavior: (reduce || far) ? 'auto' : 'smooth' });
    });

    ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(function(type){
      window.addEventListener(type, endGlide, { passive: true });
    });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    // --player-h: the bar's real height, measured rather than assumed, because it
    // is not a constant — phones stack the scrubber, live mode drops it, and the
    // bar's bottom padding carries the safe-area inset. Read from here rather
    // than hooking showPlayerBar/hidePlayerBar so the player code owes this
    // feature nothing; ResizeObserver already reports 0 for a display:none bar,
    // and the MutationObserver covers the hidden/live attribute flips that a
    // ResizeObserver-less browser would miss.
    // --resume-h rides along for the same reason. The resume toast floats above
    // the bar and, in centred mode, in the same strip as the button — and its
    // height is not a constant either: on a 390px phone the text wraps and it
    // measures 58.8px, which a guessed 3.6rem undershoots by 9px. Publish the
    // whole strip it occupies (height + its own margin), read from the
    // stylesheet rather than restating .55rem here, and 0 while it is down.
    var toast = document.getElementById('resumeToast');
    function syncBarHeight(){
      var h = (bar && !bar.hidden) ? bar.offsetHeight : 0;
      root.style.setProperty('--player-h', h + 'px');
      var t = 0;
      if(toast && !toast.hidden){
        t = toast.offsetHeight + (parseFloat(getComputedStyle(toast).marginBottom) || 0);
      }
      root.style.setProperty('--resume-h', t + 'px');
    }
    [bar, toast].forEach(function(el){
      if(!el) return;
      if('ResizeObserver' in window) new ResizeObserver(syncBarHeight).observe(el);
      if('MutationObserver' in window){
        new MutationObserver(syncBarHeight).observe(el, {
          attributes: true, attributeFilter: ['hidden', 'class']
        });
      }
    });
    window.addEventListener('resize', syncBarHeight);
    syncBarHeight();
    measure();
  })();

  // ---------------- Leaving for somewhere else ----------------
  // Every outbound link — the sheet's Show website / Facebook / Twitter pills,
  // the RSS badges, the whole station menu — is marked target="_blank". On a
  // desktop that is right: the tab strip is visible, the tab you left is one
  // click away, and whatever is playing keeps playing in it.
  //
  // On a phone none of that holds, and the result is a one-way door. The new
  // tab has no history of its own, so its back arrow is dead; there is no tab
  // strip, so the tab you came from is hidden behind a numbered button most
  // people never press. Tapping a show's website reads as the app vanishing.
  //
  // So on touch devices we navigate in place instead. That puts this page in
  // the next one's history and makes the system Back gesture — the one
  // affordance everybody already uses — come straight back here. Returning is
  // cheap: the browser usually restores the page from its back/forward cache,
  // and when it doesn't, `pagehide` has already stored the playback position
  // (see resumeRemember) and ?show= reopens the sheet that was up.
  var leaveInPlace = window.matchMedia('(hover:none) and (pointer:coarse)');
  document.addEventListener('click', function(e){
    if(!leaveInPlace.matches) return;
    // never override the browser's own new-tab modifiers, and never fight a
    // more specific handler that has already claimed this click
    if(e.defaultPrevented || e.button !== 0) return;
    if(e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[target="_blank"][href]');
    if(!a) return;
    e.preventDefault();
    location.href = a.href;
  });

  document.getElementById('linkNoticeClose').addEventListener('click', function(){
    document.getElementById('linkNotice').hidden = true;
  });

  // Category and search arrive from the URL before the first render, so a
  // manifest shortcut or a shared link paints its result directly rather than
  // showing everything and then filtering.
  (function(){
    var cat = param('cat');
    if(cat && CAT_BY_KEY[cat]) state.cat = cat;
    var q = param('q');
    if(q){ state.query = q.trim().toLowerCase(); searchEl.value = q; }
  })();

  renderCat();
  loadArchive();
})();