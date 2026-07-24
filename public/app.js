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

  var savedView = 'list';
  try { savedView = localStorage.getItem('wbai-view') === 'grid' ? 'grid' : 'list'; } catch(e){}
  var state = { query:'', cat:'all', sortKey:'date', sortDir:'desc', view:savedView };

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

  var chipsEl = document.getElementById('chips');
  function renderChips(){
    var html = '<button class="chip" data-cat="all" aria-pressed="'+(state.cat==='all')+'">All shows</button>';
    CATS.forEach(function(c){
      html += '<button class="chip" data-cat="'+c.key+'" aria-pressed="'+(state.cat===c.key)+'">'+
        '<span class="swatch" style="background:'+c.color+'"></span>'+c.label+'</button>';
    });
    chipsEl.innerHTML = html;
  }
  chipsEl.addEventListener('click', function(e){
    var btn = e.target.closest('.chip');
    if(!btn) return;
    state.cat = btn.dataset.cat;
    renderChips();
    render();
    syncUrl();
  });

  var searchEl = document.getElementById('q');
  searchEl.addEventListener('input', function(e){
    state.query = e.target.value.trim().toLowerCase();
    render();
    syncUrl();
  });

  document.querySelectorAll('.sortbtn').forEach(function(btn){
    btn.addEventListener('click', function(){
      var key = btn.dataset.sort;
      if(state.sortKey === key){ state.sortDir = state.sortDir==='asc' ? 'desc':'asc'; }
      else { state.sortKey = key; state.sortDir = key==='title' ? 'asc':'desc'; }
      document.querySelectorAll('.sortbtn').forEach(function(b){ b.dataset.active = (b===btn); });
      render();
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
  });
  applyView();

  var rowsEl = document.getElementById('rows');
  var emptyEl = document.getElementById('emptyState');
  var loadingEl = document.getElementById('loadingState');
  var countEl = document.getElementById('resultCount');
  var clockEl = document.getElementById('clock');

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
      return (a.dt - b.dt)*dir;
    });

    loadingEl.hidden = true;
    countEl.textContent = list.length + (list.length===1 ? ' show':' shows') + ' found';
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
      '<div class="row body" role="row">'+
        '<div class="show-cell">'+
          '<span class="show-thumb" style="--c:'+c.color+'" aria-hidden="true">'+
            (photo ? '<img loading="lazy" alt="" src="'+photo+'">' : '')+
          '</span>'+
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
        '<button class="card card-art play-btn'+(isPlaying?' playing':'')+(isLoading?' loading':'')+'" style="--c:'+c.color+'" '+playAttrs(r, subLine, photo, isLoading, isPlaying)+'>'+
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
    var playing = !audio.paused && !audio.ended;
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
    showPlayerBar();
    liveAudio.pause();
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
    if(btn) togglePlayFrom(btn);
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
    if(nowPlaying.mp3){
      if(audio.paused) audio.play().catch(function(){}); else audio.pause();
      return;
    }
    if(liveLoaded) toggleLive();
  }
  playerClose.addEventListener('click', function(){
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
      var r = nowPlaying.mp3 && rowByMp3(nowPlaying.mp3);
      if(r) openSheetById(r.id, infoBtn);
    }
    document.querySelectorAll('.player-open').forEach(function(el){
      el.addEventListener('click', openForPlaying);
    });
  })();

  // ---------------- Header live stream + on-air metadata ----------------
  var liveAudio = document.getElementById('liveAudio');
  var liveStrip = document.getElementById('liveStrip');
  var liveIcon = document.getElementById('liveIcon');
  var livePlay = document.getElementById('livePlay');
  var liveNowEl = document.getElementById('liveNow');
  var liveNextEl = document.getElementById('liveNext');
  var livePhoto = document.getElementById('livePhoto');
  var liveLoaded = false;
  var liveErrored = false;

  function setLiveIcon(playing){
    liveIcon.outerHTML = playing
      ? '<svg id="liveIcon" width="17" height="17" viewBox="0 0 24 24" fill="#ffffff"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
      : '<svg id="liveIcon" width="17" height="17" viewBox="0 0 24 24" fill="#ffffff"><path d="M8 5v14l11-7z"/></svg>';
    liveIcon = document.getElementById('liveIcon');
    livePlay.classList.toggle('playing', playing);
  }

  livePhoto.addEventListener('load', function(){ livePhoto.classList.add('loaded'); });
  livePhoto.addEventListener('error', function(){ livePhoto.classList.remove('loaded'); livePhoto.removeAttribute('src'); });
  function setLivePhoto(url){
    if(url && url !== livePhoto.getAttribute('data-current')){
      livePhoto.setAttribute('data-current', url);
      livePhoto.classList.remove('loaded');
      livePhoto.src = url;
    } else if(!url){
      livePhoto.removeAttribute('data-current');
      livePhoto.removeAttribute('src');
      livePhoto.classList.remove('loaded');
    }
  }

  function setLiveLoading(on){ livePlay.classList.toggle('loading', on); }

  function toggleLive(){
    if(liveErrored){
      window.open('https://wbai.org/listen-live/', '_blank', 'noopener');
      return;
    }
    if(liveLoaded && !liveAudio.paused){
      liveAudio.pause();
      return;
    }
    if(!audio.paused) audio.pause();
    if(!liveLoaded){ liveAudio.src = LIVE_URL; liveLoaded = true; }
    setLiveLoading(true);
    liveStrip.setAttribute('aria-label','Connecting to WBAI live stream');
    liveAudio.play().catch(function(){});
  }

  liveAudio.addEventListener('waiting', function(){ if(liveAudio.paused===false) setLiveLoading(true); });
  liveAudio.addEventListener('playing', function(){
    setLiveLoading(false); setLiveIcon(true);
    liveStrip.setAttribute('aria-label','Pause WBAI live stream');
    activateLiveSession();
  });
  liveAudio.addEventListener('pause', function(){
    setLiveLoading(false); setLiveIcon(false);
    liveStrip.setAttribute('aria-label','Play WBAI live stream');
    if(mediaMode === 'live') setPlaybackState('paused');
  });
  liveAudio.addEventListener('error', function(){
    liveErrored = true;
    setLiveLoading(false);
    setLiveIcon(false);
    liveNowEl.textContent = 'Playback blocked — tap to open on wbai.org';
    liveStrip.setAttribute('aria-label','Open WBAI live stream on wbai.org');
  });
  liveStrip.addEventListener('click', toggleLive);

  audio.addEventListener('play', function(){ if(liveLoaded && !liveAudio.paused) liveAudio.pause(); });

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
      if(!nowPlaying.mp3 && !liveLoaded) return;
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
  liveAudio.addEventListener('play', claimAudioSession);

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
    setHandler('play', function(){ if(liveAudio.paused) toggleLive(); });
    setHandler('pause', function(){ liveAudio.pause(); });
    setHandler('stop', function(){ liveAudio.pause(); });
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
    var fullTxt = cur.name + (cur.dj ? ' · ' + cur.dj : '');
    liveNowEl.textContent = cur.name;
    liveNowEl.title = fullTxt + ' (' + cur.start + '–' + cur.end + ')' + (isLive ? '' : ' — snapshot, live sync unavailable here');
    liveNextEl.textContent = nxt.name ? ('Next: ' + nxt.name + ' · ' + nxt.start) : '';
    setLivePhoto(cur.photo || null);

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
  function setClock(){
    if(!latestDt){ clockEl.textContent = ''; return; }
    var d = new Date(latestDt*1000);
    clockEl.textContent = 'Synced through ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }

  function ingest(list){
    rows = list;
    latestDt = rows.reduce(function(max,r){ return Math.max(max, r.dt); }, 0);
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
    countEl.textContent = 'Loading shows…';
    fetch('/api/archive', {cache:'no-store'})
      .then(function(r){ if(!r.ok) throw new Error('archive '+r.status); return r.json(); })
      .then(function(data){ ingest(data.shows || []); })
      .catch(function(){
        // fall back to the shipped snapshot if the live scrape is unavailable
        fetch('/data/shows-fallback.json', {cache:'no-store'})
          .then(function(r){ return r.json(); })
          .then(function(data){ ingest(data.shows || []); })
          .catch(function(){ loadingEl.hidden = true; countEl.textContent = 'Could not load the archive.'; emptyEl.hidden = false; });
      });
  }

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
    return '<a class="sheet-link" href="'+esc(href)+'" target="_blank" rel="noopener noreferrer">'+icon+esc(label)+'</a>';
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
    if(site) links += sheetLink(site, svgLink(), 'Show website');
    var fb = safeUrl(info.facebook || prog.facebook);
    if(fb) links += sheetLink(fb, svgFacebook(), 'Facebook');
    var tw = safeUrl(prog.twitter);
    if(tw) links += sheetLink(tw, svgLink(), 'Twitter');
    // Rendered only where the OS can actually take it, in keeping with the
    // sheet's rule that nothing is shown as an inert placeholder.
    if(navigator.share) links += '<button class="sheet-link sheet-share" type="button">'+svgShare()+'Share</button>';

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
        '<div class="sheet-head" style="--c:'+c.color+'">'+
          '<span class="sheet-art" aria-hidden="true">'+
            (photo ? '<img alt="" src="'+esc(photo)+'">' : '')+
          '</span>'+
          '<div class="sheet-titles">'+
            (c.label ? '<span class="sheet-eyebrow"><span class="swatch"></span>'+esc(c.label)+'</span>' : '')+
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
    sheet.classList.add('show');
    sheetScrim.classList.add('show');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('sheet-open');
    sheetClose.focus();
    document.addEventListener('keydown', onSheetKey);

    // the directory arrives on first open; repaint if this sheet is still up
    if(!programs){
      ensurePrograms().then(function(){
        var same = rowById(sheetRowId);
        if(same && sheet.classList.contains('show')) paintSheet(same);
      });
    }
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
    sheet.classList.remove('show');
    sheetScrim.classList.remove('show');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('sheet-open');
    document.removeEventListener('keydown', onSheetKey);
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
  })();

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

  renderChips();
  loadArchive();
})();