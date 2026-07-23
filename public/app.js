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


  var rows = [];

  var latestDt = 0;

  var state = { query:'', cat:'all', sortKey:'date', sortDir:'desc' };

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
  });

  document.getElementById('q').addEventListener('input', function(e){
    state.query = e.target.value.trim().toLowerCase();
    render();
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

  function svgPlay(){ return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>'; }
  function svgPause(){ return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'; }
  function svgRss(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"/><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/></svg>'; }
  function svgSpin(){ return '<span class="btn-spin"></span>'; }

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
    return list.map(function(r){
      var c = CAT_BY_KEY[r.cat];
      var rc = retentionClass(r.daysLeft);
      var dparts = splitDateText(r.dateText);
      var isLoading = (loadingMp3===r.mp3);
      var isPlaying = (nowPlaying.mp3===r.mp3 && !audio.paused && !audio.ended && !isLoading);
      var subLine = c.label + (r.host ? ' · with '+esc(r.host) : '');
      var photo = r.photo || '';
      var btnInner = isLoading ? svgSpin() : (isPlaying ? svgPause() : svgPlay());
      return (
      '<div class="row body" role="row">'+
        '<div class="show-cell">'+
          '<span class="show-thumb" style="--c:'+c.color+'" aria-hidden="true">'+
            (photo ? '<img loading="lazy" alt="" src="'+photo+'">' : '')+
          '</span>'+
          '<span style="min-width:0;">'+
            '<span class="show-title">'+esc(r.title)+'</span>'+
            '<span class="show-cat">'+subLine+' <span class="cell-duration inline-meta">· '+esc(r.length)+'</span></span>'+
          '</span>'+
          (r.hasRSS ? '<a class="rss-badge" href="'+RSS_BASE+encodeURIComponent(r.sho)+'" target="_blank" rel="noopener noreferrer" title="Subscribe to the RSS feed for '+esc(r.title)+'">'+svgRss()+'</a>' : '')+
        '</div>'+
        '<div class="cell-date"><b>'+esc(dparts.date)+'</b><span>'+esc(dparts.time)+'</span></div>'+
        '<div class="cell-mono cell-duration">'+esc(r.length)+'</div>'+
        '<div><span class="retention '+rc+'">'+retentionLabel(r.daysLeft)+'</span></div>'+
        '<div class="row-actions">'+
          '<button class="play-btn'+(isPlaying?' playing':'')+(isLoading?' loading':'')+'" data-mp3="'+esc(r.mp3)+'" data-title="'+esc(r.title)+'" data-sub="'+esc(subLine)+'" data-photo="'+esc(photo)+'" aria-label="'+(isLoading?'Loading':(isPlaying?'Pause':'Play'))+' '+esc(r.title)+'">'+btnInner+'</button>'+
        '</div>'+
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

  var nowPlaying = { mp3:null };
  var loadingMp3 = null;
  var seeking = false;   // true while the user drags the scrubber

  function formatTime(sec){
    if(!isFinite(sec) || sec < 0) return '0:00';
    sec = Math.floor(sec);
    var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    var mm = h ? (m<10?'0'+m:''+m) : ''+m;
    return (h ? h+':' : '') + mm + ':' + (s<10?'0'+s:''+s);
  }
  function setScrubFill(){
    var max = +playerRange.max || 0;
    var pct = max ? (+playerRange.value / max) * 100 : 0;
    playerRange.style.setProperty('--pct', pct);
  }
  function resetScrubber(){
    seeking = false;
    playerRange.disabled = true;
    playerRange.max = 0;
    playerRange.value = 0;
    setScrubFill();
    playerCurrent.textContent = '0:00';
    playerDuration.textContent = '0:00';
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
      ? '<svg id="playerIcon" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
      : '<svg id="playerIcon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    playerIcon = document.getElementById('playerIcon');
  }

  function updatePlayButtons(){
    document.querySelectorAll('.play-btn').forEach(function(btn){
      var mp3 = btn.dataset.mp3;
      var loading = (mp3 === loadingMp3);
      var playing = (mp3 === nowPlaying.mp3) && !audio.paused && !audio.ended && !loading;
      btn.classList.toggle('playing', playing);
      btn.classList.toggle('loading', loading);
      btn.innerHTML = loading ? svgSpin() : (playing ? svgPause() : svgPlay());
      btn.setAttribute('aria-label', (loading?'Loading ':(playing?'Pause ':'Play ')) + btn.dataset.title);
    });
    refreshToggleIcon();
  }

  function playTrack(mp3, title, sub, photo){
    nowPlaying.mp3 = mp3;
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

  audio.addEventListener('playing', function(){ loadingMp3 = null; setStatus('Playing'); updatePlayButtons(); });
  audio.addEventListener('pause', function(){ loadingMp3 = null; if(!audio.ended) setStatus('Paused'); updatePlayButtons(); });
  audio.addEventListener('ended', function(){ loadingMp3 = null; setStatus('Finished'); updatePlayButtons(); });

  // ---- scrubber wiring ----
  audio.addEventListener('loadedmetadata', function(){
    if(isFinite(audio.duration) && audio.duration > 0){
      playerRange.max = Math.floor(audio.duration);
      playerRange.disabled = false;
      playerDuration.textContent = formatTime(audio.duration);
    }
    setScrubFill();
  });
  audio.addEventListener('timeupdate', function(){
    if(seeking) return;
    playerRange.value = Math.floor(audio.currentTime);
    playerCurrent.textContent = formatTime(audio.currentTime);
    setScrubFill();
  });
  // live preview while dragging; commit the seek on release
  playerRange.addEventListener('input', function(){
    seeking = true;
    playerCurrent.textContent = formatTime(+playerRange.value);
    setScrubFill();
  });
  playerRange.addEventListener('change', function(){
    if(isFinite(audio.duration)) audio.currentTime = +playerRange.value;
    seeking = false;
  });
  audio.addEventListener('waiting', function(){ setStatus('Buffering…'); });
  audio.addEventListener('error', function(){
    loadingMp3 = null;
    setStatus('Playback blocked here — <a href="'+nowPlaying.mp3+'" target="_blank" rel="noopener noreferrer">open on wbai.org →</a>');
    updatePlayButtons();
  });

  rowsEl.addEventListener('click', function(e){
    var btn = e.target.closest('.play-btn');
    if(!btn) return;
    var mp3 = btn.dataset.mp3;
    if(mp3 === loadingMp3) return;
    if(nowPlaying.mp3 === mp3 && !audio.paused && !audio.ended){
      audio.pause();
    } else {
      playTrack(mp3, btn.dataset.title, btn.dataset.sub, btn.dataset.photo);
    }
  });

  // Show artwork is layered on top of the category placeholder and paints itself
  // once decoded (cached or not — no load event to miss). If it errors, hide it
  // so the placeholder shows through.
  rowsEl.addEventListener('error', function(e){
    if(e.target && e.target.tagName === 'IMG') e.target.classList.add('failed');
  }, true);

  playerToggle.addEventListener('click', function(){
    if(!nowPlaying.mp3) return;
    if(audio.paused) audio.play().catch(function(){}); else audio.pause();
  });
  playerClose.addEventListener('click', function(){
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    nowPlaying.mp3 = null;
    resetScrubber();
    hidePlayerBar();
    updatePlayButtons();
  });

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
      ? '<svg id="liveIcon" viewBox="0 0 24 24" fill="#ffffff"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
      : '<svg id="liveIcon" viewBox="0 0 24 24" fill="#ffffff"><path d="M8 5v14l11-7z"/></svg>';
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
  liveAudio.addEventListener('playing', function(){ setLiveLoading(false); setLiveIcon(true); liveStrip.setAttribute('aria-label','Pause WBAI live stream'); });
  liveAudio.addEventListener('pause', function(){ setLiveLoading(false); setLiveIcon(false); liveStrip.setAttribute('aria-label','Play WBAI live stream'); });
  liveAudio.addEventListener('error', function(){
    liveErrored = true;
    setLiveLoading(false);
    setLiveIcon(false);
    liveNowEl.textContent = 'Playback blocked — tap to open on wbai.org';
    liveStrip.setAttribute('aria-label','Open WBAI live stream on wbai.org');
  });
  liveStrip.addEventListener('click', toggleLive);

  audio.addEventListener('play', function(){ if(liveLoaded && !liveAudio.paused) liveAudio.pause(); });

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

  renderChips();
  loadArchive();
})();