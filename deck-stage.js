/**
 * <deck-stage> — reusable web component for HTML decks.
 *
 * Handles:
 *  (a) speaker notes — reads <script type="application/json" id="speaker-notes">
 *      and posts {slideIndexChanged: N} to the parent window on nav.
 *  (b) keyboard navigation — ←/→, PgUp/PgDn, Space, Home/End, number keys.
 *  (c) press R to reset to slide 0 (with a tasteful keyboard hint).
 *  (d) bottom-center overlay showing slide count + hints, fades out on idle.
 *  (e) auto-scaling — inner canvas is a fixed design size (default 1920×1080)
 *      scaled with `transform: scale()` to fit the viewport, letterboxed.
 *      Set the `noscale` attribute to render at authored size (1:1) — the
 *      PPTX exporter sets this so its DOM capture sees unscaled geometry.
 *  (f) print — `@media print` lays every slide out as its own page at the
 *      design size, so the browser's Print → Save as PDF produces a clean
 *      one-page-per-slide PDF with no extra setup.
 *  (g) [NEW] speaker view — press S or click the "Presenter" button in the
 *      overlay to open a presenter window. Shows: current slide thumbnail,
 *      next slide thumbnail, speaker notes, elapsed timer, slide counter.
 *      The two windows stay in sync via BroadcastChannel, with a
 *      localStorage + postMessage fallback for file:// usage.
 *
 * Slides are HIDDEN, not unmounted. Non-active slides stay in the DOM with
 * `visibility: hidden` + `opacity: 0`, so their state (videos, iframes,
 * form inputs, React trees) is preserved across navigation.
 *
 * Lifecycle event — the component dispatches a `slidechange` CustomEvent on
 * itself whenever the active slide changes (including the initial mount).
 *
 *   document.querySelector('deck-stage').addEventListener('slidechange', (e) => {
 *     e.detail.index         // new 0-based index
 *     e.detail.previousIndex // previous index, or -1 on init
 *     e.detail.total         // total slide count
 *     e.detail.slide         // the new active slide element
 *     e.detail.previousSlide // the prior slide element, or null on init
 *     e.detail.reason        // 'init' | 'keyboard' | 'click' | 'tap' | 'api'
 *   });
 *
 * Persistence: current slide index is saved to localStorage keyed by the
 * document path, so refresh returns you to the same place.
 *
 * Usage:
 *   <deck-stage width="1920" height="1080">
 *     <section data-label="Title">...</section>
 *     <section data-label="Agenda">...</section>
 *   </deck-stage>
 *   <script src="deck-stage.js"></script>
 *
 * Public API:
 *   el.goTo(n)         — navigate to slide n (0-based)
 *   el.next()          — next slide
 *   el.prev()          — previous slide
 *   el.reset()         — go to slide 0
 *   el.openPresenter() — open presenter window
 *   el.closePresenter()— close presenter window
 *   el.index           — current index (read-only)
 *   el.length          — total slides (read-only)
 */

(() => {
  const DESIGN_W_DEFAULT = 1920;
  const DESIGN_H_DEFAULT = 1080;
  const STORAGE_PREFIX   = 'deck-stage:slide:';
  const OVERLAY_HIDE_MS  = 1800;
  const VALIDATE_ATTR    = 'no_overflowing_text,no_overlapping_text,slide_sized_text';
  const BC_NAME          = 'deck-stage:presenter';

  const pad2 = (n) => String(n).padStart(2, '0');

  // ── Presenter window HTML (injected as a blob URL) ────────────────────────
  const PRESENTER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Presenter View</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#0d1117;--surface:#161b22;--border:rgba(255,255,255,0.08);
    --gold:#C9A961;--text:#e6edf3;--muted:rgba(230,237,243,0.45);
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  }
  html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--sans);overflow:hidden}
  body{display:flex;flex-direction:column}

  /* ── top bar ── */
  .topbar{
    display:flex;align-items:center;gap:16px;flex-shrink:0;
    padding:10px 16px;border-bottom:1px solid var(--border);background:var(--surface);
  }
  .timer{
    font-family:var(--mono);font-size:26px;font-weight:600;
    color:var(--gold);letter-spacing:.06em;min-width:72px;
  }
  .timer.warn{color:#e05c3a}
  .counter{font-family:var(--mono);font-size:13px;color:var(--muted);flex:1}
  .counter b{color:var(--text)}
  .btn-reset{
    background:none;border:1px solid var(--border);color:var(--muted);
    font-family:var(--mono);font-size:11px;padding:3px 10px;border-radius:4px;
    cursor:pointer;transition:border-color .15s,color .15s;letter-spacing:.04em;
  }
  .btn-reset:hover{border-color:var(--gold);color:var(--gold)}

  /* ── progress bar ── */
  .progress-wrap{height:3px;background:rgba(255,255,255,.08);flex-shrink:0}
  .progress-bar{height:100%;background:var(--gold);transition:width .25s}

  /* ── notes ── */
  .notes-body{
    flex:1;overflow-y:auto;padding:20px 22px;
    font-size:16px;line-height:1.8;color:var(--text);
  }
  .notes-body p{margin-bottom:.85em}
  .notes-body::-webkit-scrollbar{width:4px}
  .notes-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:2px}
  .notes-empty{color:var(--muted);font-style:italic}

  /* ── bottom nav ── */
  .nav{
    display:flex;align-items:center;justify-content:center;gap:14px;
    padding:10px 16px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0;
  }
  .nav-btn{
    background:none;border:1px solid var(--border);color:var(--text);
    font-family:var(--mono);font-size:13px;padding:5px 20px;border-radius:4px;
    cursor:pointer;transition:background .12s,border-color .12s;
  }
  .nav-btn:hover{background:rgba(255,255,255,.07);border-color:rgba(255,255,255,.2)}
  .nav-btn:active{background:rgba(255,255,255,.12)}
  .nav-count{font-family:var(--mono);font-size:13px;color:var(--muted);min-width:60px;text-align:center}
  .nav-count b{color:var(--text)}
</style>
</head>
<body>
<div class="topbar">
  <div class="timer" id="timer">00:00</div>
  <span class="counter"><b id="cur-num">1</b> / <b id="tot-num">—</b></span>
  <button class="btn-reset" id="btn-reset">Reset</button>
</div>

<div class="progress-wrap"><div class="progress-bar" id="progress" style="width:0%"></div></div>

<div class="notes-body" id="notes-body">
  <span class="notes-empty">Waiting for main window…</span>
</div>

<div class="nav">
  <button class="nav-btn" id="nav-prev">◀ Prev</button>
  <span class="nav-count"><b id="nav-cur">1</b> / <b id="nav-tot">—</b></span>
  <button class="nav-btn" id="nav-next">Next ▶</button>
</div>

<script>
(function(){
  var state = { index:0, total:1, notes:[] };
  var startTime = Date.now();

  var timerEl   = document.getElementById('timer');
  var progressEl= document.getElementById('progress');

  function pad2(n){ return String(n).padStart(2,'0'); }
  function tick(){
    var s = Math.floor((Date.now()-startTime)/1000);
    timerEl.textContent = pad2(Math.floor(s/60))+':'+pad2(s%60);
    timerEl.className = 'timer'+(s>=1200?' warn':'');
  }
  setInterval(tick, 500);
  document.getElementById('btn-reset').onclick = function(){ startTime=Date.now(); tick(); };

  function render(){
    var i = state.index, total = state.total;
    document.getElementById('cur-num').textContent = i+1;
    document.getElementById('tot-num').textContent = total;
    document.getElementById('nav-cur').textContent = i+1;
    document.getElementById('nav-tot').textContent = total;
    progressEl.style.width = (total > 1 ? (i/(total-1))*100 : 100)+'%';

    var note = state.notes[i];
    var nb = document.getElementById('notes-body');
    if(note && note.trim()){
      nb.innerHTML = '';
      note.split('\\n').forEach(function(para){
        if(!para.trim()) return;
        var p = document.createElement('p'); p.textContent = para; nb.appendChild(p);
      });
      nb.scrollTop = 0;
    } else {
      nb.innerHTML = '<span class="notes-empty">（本页无演讲备注）</span>';
    }
  }

  function handleMsg(data){
    if(!data||typeof data!=='object') return;
    if(data.type==='deck-state'){
      var changed = data.index!==state.index||data.total!==state.total;
      state = Object.assign({},state,data);
      if(changed) render();
    }
  }

  function sendNav(action){
    var msg = { type:'deck-nav', action:action };
    if(bc) bc.postMessage(msg);
    try{ localStorage.setItem('deck-stage:presenter:nav', JSON.stringify(Object.assign({t:Date.now()},msg))); }catch(_){}
    if(window.opener) window.opener.postMessage(msg,'*');
  }

  var bc = null;
  try{ bc = new BroadcastChannel('deck-stage:presenter'); bc.onmessage=function(e){handleMsg(e.data);}; }catch(_){}
  window.addEventListener('message', function(e){ handleMsg(e.data); });
  window.addEventListener('storage', function(e){
    if(e.key==='deck-stage:presenter:state'){ try{handleMsg(JSON.parse(e.newValue));}catch(_){} }
  });

  document.getElementById('nav-prev').onclick = function(){ sendNav('prev'); };
  document.getElementById('nav-next').onclick = function(){ sendNav('next'); };
  document.addEventListener('keydown', function(e){
    if(e.key==='ArrowRight'||e.key===' '){ e.preventDefault(); sendNav('next'); }
    if(e.key==='ArrowLeft'){ e.preventDefault(); sendNav('prev'); }
  });

  if(window.opener) window.opener.postMessage({type:'deck-presenter-ready'},'*');
  setTimeout(function(){
    try{ var r=localStorage.getItem('deck-stage:presenter:state'); if(r) handleMsg(JSON.parse(r)); }catch(_){}
  }, 300);
})();
<\/script>
</body>
</html>`;

  // ── Main component stylesheet ─────────────────────────────────────────────
  const stylesheet = `
    :host {
      position: fixed; inset: 0; display: block;
      background: #000; color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
      overflow: hidden;
    }
    .stage { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
    .canvas { position: relative; transform-origin: center center; flex-shrink: 0; background: #fff; will-change: transform; }
    ::slotted(*) {
      position: absolute !important; inset: 0 !important;
      width: 100% !important; height: 100% !important;
      box-sizing: border-box !important; overflow: hidden;
      opacity: 0; pointer-events: none; visibility: hidden;
    }
    ::slotted([data-deck-active]) { opacity: 1; pointer-events: auto; visibility: visible; }
    .tapzones { position: fixed; inset: 0; display: flex; z-index: 2147482000; pointer-events: none; }
    .tapzone   { flex: 1; pointer-events: auto; -webkit-tap-highlight-color: transparent; }
    @media (hover: hover) and (pointer: fine) { .tapzones { display: none; } }
    .overlay {
      position: fixed; left: 50%; bottom: 22px;
      transform: translate(-50%, 6px) scale(0.92); filter: blur(6px);
      display: flex; align-items: center; gap: 4px; padding: 4px;
      background: #000; color: #fff; border-radius: 999px;
      font-size: 12px; font-feature-settings: "tnum" 1; letter-spacing: 0.01em;
      opacity: 0; pointer-events: none;
      transition: opacity 260ms ease, transform 260ms cubic-bezier(.2,.8,.2,1), filter 260ms ease;
      transform-origin: center bottom; z-index: 2147483000; user-select: none;
    }
    .overlay[data-visible] { opacity: 1; pointer-events: auto; transform: translate(-50%, 0) scale(1); filter: blur(0); }
    .btn {
      appearance: none; -webkit-appearance: none; background: transparent; border: 0; margin: 0; padding: 0;
      color: inherit; font: inherit; cursor: default; display: inline-flex; align-items: center;
      justify-content: center; height: 28px; min-width: 28px; border-radius: 999px;
      color: rgba(255,255,255,0.72); transition: background 140ms ease, color 140ms ease;
      -webkit-tap-highlight-color: transparent;
    }
    .btn:hover  { background: rgba(255,255,255,0.12); color: #fff; }
    .btn:active { background: rgba(255,255,255,0.18); }
    .btn:focus, .btn:focus-visible { outline: none; }
    .btn::-moz-focus-inner { border: 0; }
    .btn svg { width: 14px; height: 14px; display: block; }
    .btn.reset, .btn.presenter {
      font-size: 11px; font-weight: 500; letter-spacing: 0.02em;
      padding: 0 10px 0 12px; gap: 6px; color: rgba(255,255,255,0.72);
    }
    .btn.presenter { padding: 0 10px 0 8px; gap: 5px; }
    .btn.presenter[data-active] { color: #C9A961; background: rgba(201,169,97,0.12); }
    .kbd {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 16px; height: 16px; padding: 0 4px;
      font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
      font-size: 10px; line-height: 1; color: rgba(255,255,255,0.88);
      background: rgba(255,255,255,0.12); border-radius: 4px;
    }
    .count {
      font-variant-numeric: tabular-nums; color: #fff; font-weight: 500;
      padding: 0 8px; min-width: 42px; text-align: center; font-size: 12px;
    }
    .count .sep   { color: rgba(255,255,255,0.45); margin: 0 3px; font-weight: 400; }
    .count .total { color: rgba(255,255,255,0.55); }
    .divider { width: 1px; height: 14px; background: rgba(255,255,255,0.18); margin: 0 2px; }

    @media print {
      :host { position: static; inset: auto; background: none; overflow: visible; color: inherit; }
      .stage { position: static; display: block; }
      .canvas { transform: none !important; width: auto !important; height: auto !important; background: none; will-change: auto; }
      ::slotted(*) {
        position: relative !important; inset: auto !important;
        width: var(--deck-design-w) !important; height: var(--deck-design-h) !important;
        box-sizing: border-box !important; opacity: 1 !important; visibility: visible !important;
        pointer-events: auto; break-after: page; page-break-after: always; break-inside: avoid; overflow: hidden;
      }
      ::slotted(*:last-child) { break-after: auto; page-break-after: auto; }
      .overlay, .tapzones { display: none !important; }
    }
  `;

  class DeckStage extends HTMLElement {
    static get observedAttributes() { return ['width', 'height', 'noscale']; }

    constructor() {
      super();
      this._root = this.attachShadow({ mode: 'open' });
      this._index = 0;
      this._slides = [];
      this._notes = [];
      this._hideTimer = null;
      this._storageKey = STORAGE_PREFIX + (location.pathname || '/');

      // Presenter state
      this._presenterWin = null;
      this._presenterBlobURL = null;
      this._presenterPollTimer = null;
      this._bc = null;

      this._onKey        = this._onKey.bind(this);
      this._onResize     = this._onResize.bind(this);
      this._onSlotChange = this._onSlotChange.bind(this);
      this._onMouseMove  = this._onMouseMove.bind(this);
      this._onTapBack    = this._onTapBack.bind(this);
      this._onTapForward = this._onTapForward.bind(this);
      this._onMessage    = this._onMessage.bind(this);
      this._onStorage    = this._onStorage.bind(this);
    }

    get designWidth()  { return parseInt(this.getAttribute('width'),  10) || DESIGN_W_DEFAULT; }
    get designHeight() { return parseInt(this.getAttribute('height'), 10) || DESIGN_H_DEFAULT; }

    connectedCallback() {
      this._render();
      this._loadNotes();
      this._syncPrintPageRule();
      this._initBC();
      window.addEventListener('keydown',   this._onKey);
      window.addEventListener('resize',    this._onResize);
      window.addEventListener('mousemove', this._onMouseMove, { passive: true });
      window.addEventListener('message',   this._onMessage);
      window.addEventListener('storage',   this._onStorage);
    }

    disconnectedCallback() {
      window.removeEventListener('keydown',   this._onKey);
      window.removeEventListener('resize',    this._onResize);
      window.removeEventListener('mousemove', this._onMouseMove);
      window.removeEventListener('message',   this._onMessage);
      window.removeEventListener('storage',   this._onStorage);
      if (this._hideTimer) clearTimeout(this._hideTimer);
      if (this._presenterPollTimer) clearInterval(this._presenterPollTimer);
      this._cleanupPresenter();
    }

    attributeChangedCallback() {
      if (this._canvas) {
        this._canvas.style.width  = this.designWidth  + 'px';
        this._canvas.style.height = this.designHeight + 'px';
        this._canvas.style.setProperty('--deck-design-w', this.designWidth  + 'px');
        this._canvas.style.setProperty('--deck-design-h', this.designHeight + 'px');
        this._fit();
        this._syncPrintPageRule();
      }
    }

    _render() {
      const style = document.createElement('style');
      style.textContent = stylesheet;

      const stage = document.createElement('div');
      stage.className = 'stage';

      const canvas = document.createElement('div');
      canvas.className = 'canvas';
      canvas.style.width  = this.designWidth  + 'px';
      canvas.style.height = this.designHeight + 'px';
      canvas.style.setProperty('--deck-design-w', this.designWidth  + 'px');
      canvas.style.setProperty('--deck-design-h', this.designHeight + 'px');

      const slot = document.createElement('slot');
      slot.addEventListener('slotchange', this._onSlotChange);
      canvas.appendChild(slot);
      stage.appendChild(canvas);

      // Tap zones
      const tapzones = document.createElement('div');
      tapzones.className = 'tapzones export-hidden';
      tapzones.setAttribute('aria-hidden', 'true');
      const tzBack = document.createElement('div'); tzBack.className = 'tapzone tapzone--back';
      const tzMid  = document.createElement('div'); tzMid.className  = 'tapzone tapzone--mid'; tzMid.style.pointerEvents = 'none';
      const tzFwd  = document.createElement('div'); tzFwd.className  = 'tapzone tapzone--fwd';
      tzBack.addEventListener('click', this._onTapBack);
      tzFwd.addEventListener('click',  this._onTapForward);
      tapzones.append(tzBack, tzMid, tzFwd);

      // Overlay
      const overlay = document.createElement('div');
      overlay.className = 'overlay export-hidden';
      overlay.setAttribute('role', 'toolbar');
      overlay.setAttribute('aria-label', 'Deck controls');
      overlay.innerHTML = `
        <button class="btn prev" type="button" aria-label="Previous slide" title="Previous (←)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>
        </button>
        <span class="count" aria-live="polite"><span class="current">1</span><span class="sep">/</span><span class="total">1</span></span>
        <button class="btn next" type="button" aria-label="Next slide" title="Next (→)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>
        </button>
        <span class="divider"></span>
        <button class="btn reset" type="button" aria-label="Reset to first slide" title="Reset (R)">Reset<span class="kbd">R</span></button>
        <span class="divider"></span>
        <button class="btn presenter" type="button" aria-label="Open presenter view" title="Presenter view (S)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:13px;height:13px"><rect x="1" y="2" width="14" height="9" rx="1.5"/><path d="M5.5 14h5M8 11v3"/></svg>
          Presenter<span class="kbd">S</span>
        </button>
      `;
      overlay.querySelector('.prev').addEventListener('click',      () => this._go(this._index - 1, 'click'));
      overlay.querySelector('.next').addEventListener('click',      () => this._go(this._index + 1, 'click'));
      overlay.querySelector('.reset').addEventListener('click',     () => this._go(0, 'click'));
      overlay.querySelector('.presenter').addEventListener('click', () => this._togglePresenter());

      this._root.append(style, stage, tapzones, overlay);
      this._canvas      = canvas;
      this._slot        = slot;
      this._overlay     = overlay;
      this._countEl     = overlay.querySelector('.current');
      this._totalEl     = overlay.querySelector('.total');
      this._presenterBtn= overlay.querySelector('.presenter');
    }

    _syncPrintPageRule() {
      const id = 'deck-stage-print-page';
      let tag = document.getElementById(id);
      if (!tag) { tag = document.createElement('style'); tag.id = id; document.head.appendChild(tag); }
      tag.textContent =
        '@page { size: ' + this.designWidth + 'px ' + this.designHeight + 'px; margin: 0; } ' +
        '@media print { html, body { margin: 0 !important; padding: 0 !important; background: none !important; overflow: visible !important; height: auto !important; } ' +
        '* { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }';
    }

    _onSlotChange() {
      this._collectSlides();
      this._restoreIndex();
      this._applyIndex({ showOverlay: false, broadcast: true, reason: 'init' });
      this._fit();
    }

    _collectSlides() {
      const assigned = this._slot.assignedElements({ flatten: true });
      this._slides = assigned.filter(el => {
        const tag = el.tagName;
        return tag !== 'TEMPLATE' && tag !== 'SCRIPT' && tag !== 'STYLE';
      });
      this._slides.forEach((slide, i) => {
        const n = i + 1;
        let label = slide.getAttribute('data-label');
        if (!label) {
          const existing = slide.getAttribute('data-screen-label');
          if (existing) label = existing.replace(/^\s*\d+\s*/, '').trim() || existing;
        }
        if (!label) {
          const h = slide.querySelector('h1, h2, h3, [data-title]');
          if (h) label = (h.textContent || '').trim().slice(0, 40);
        }
        if (!label) label = 'Slide';
        slide.setAttribute('data-screen-label', `${pad2(n)} ${label}`);
        if (!slide.hasAttribute('data-om-validate')) slide.setAttribute('data-om-validate', VALIDATE_ATTR);
        slide.setAttribute('data-deck-slide', String(i));
      });
      if (this._totalEl) this._totalEl.textContent = String(this._slides.length || 1);
      if (this._index >= this._slides.length) this._index = Math.max(0, this._slides.length - 1);
    }

    _loadNotes() {
      const tag = document.getElementById('speaker-notes');
      if (!tag) { this._notes = []; return; }
      try {
        const parsed = JSON.parse(tag.textContent || '[]');
        if (Array.isArray(parsed)) this._notes = parsed;
      } catch (e) {
        console.warn('[deck-stage] Failed to parse #speaker-notes JSON:', e);
        this._notes = [];
      }
    }

    _restoreIndex() {
      try {
        const raw = localStorage.getItem(this._storageKey);
        if (raw != null) {
          const n = parseInt(raw, 10);
          if (Number.isFinite(n) && n >= 0 && n < this._slides.length) this._index = n;
        }
      } catch (e) {}
    }

    _persistIndex() {
      try { localStorage.setItem(this._storageKey, String(this._index)); } catch (e) {}
    }

    _applyIndex({ showOverlay = true, broadcast = true, reason = 'init' } = {}) {
      if (!this._slides.length) return;
      const prev = this._prevIndex == null ? -1 : this._prevIndex;
      const curr = this._index;
      this._slides.forEach((s, i) => {
        if (i === curr) s.setAttribute('data-deck-active', '');
        else s.removeAttribute('data-deck-active');
      });
      if (this._countEl) this._countEl.textContent = String(curr + 1);
      this._persistIndex();

      if (broadcast) {
        try { window.postMessage({ slideIndexChanged: curr }, '*'); } catch (e) {}
        this.dispatchEvent(new CustomEvent('slidechange', {
          detail: {
            index: curr, previousIndex: prev, total: this._slides.length,
            slide: this._slides[curr] || null,
            previousSlide: prev >= 0 ? (this._slides[prev] || null) : null,
            reason,
          },
          bubbles: true, composed: true,
        }));
        this._broadcastToPresenter();
      }
      this._prevIndex = curr;
      if (showOverlay) this._flashOverlay();
    }

    _flashOverlay() {
      if (!this._overlay) return;
      this._overlay.setAttribute('data-visible', '');
      if (this._hideTimer) clearTimeout(this._hideTimer);
      this._hideTimer = setTimeout(() => this._overlay.removeAttribute('data-visible'), OVERLAY_HIDE_MS);
    }

    _fit() {
      if (!this._canvas) return;
      if (this.hasAttribute('noscale')) { this._canvas.style.transform = 'none'; return; }
      const s = Math.min(window.innerWidth / this.designWidth, window.innerHeight / this.designHeight);
      this._canvas.style.transform = `scale(${s})`;
    }

    _onResize()    { this._fit(); }
    _onMouseMove() { this._flashOverlay(); }

    _onTapBack(e)    { e.preventDefault(); this._go(this._index - 1, 'tap'); }
    _onTapForward(e) { e.preventDefault(); this._go(this._index + 1, 'tap'); }

    _onKey(e) {
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key;
      let handled = true;
      if      (key === 'ArrowRight' || key === 'PageDown' || key === ' ' || key === 'Spacebar') this._go(this._index + 1, 'keyboard');
      else if (key === 'ArrowLeft'  || key === 'PageUp')   this._go(this._index - 1, 'keyboard');
      else if (key === 'Home')                             this._go(0, 'keyboard');
      else if (key === 'End')                              this._go(this._slides.length - 1, 'keyboard');
      else if (key === 'r' || key === 'R')                 this._go(0, 'keyboard');
      else if (key === 's' || key === 'S')                 this._togglePresenter();
      else if (/^[0-9]$/.test(key)) {
        const n = key === '0' ? 9 : parseInt(key, 10) - 1;
        if (n < this._slides.length) this._go(n, 'keyboard');
      } else { handled = false; }
      if (handled) { e.preventDefault(); this._flashOverlay(); }
    }

    _go(i, reason = 'api') {
      if (!this._slides.length) return;
      const clamped = Math.max(0, Math.min(this._slides.length - 1, i));
      if (clamped === this._index) { this._flashOverlay(); return; }
      this._index = clamped;
      this._applyIndex({ showOverlay: true, broadcast: true, reason });
    }

    // ── Presenter channel ─────────────────────────────────────────────────

    _initBC() {
      try {
        this._bc = new BroadcastChannel(BC_NAME);
        this._bc.onmessage = (e) => this._handlePresenterMsg(e.data);
      } catch (e) { /* file:// fallback via storage events */ }
    }

    _onMessage(e) { if (e.data && typeof e.data === 'object') this._handlePresenterMsg(e.data); }

    _onStorage(e) {
      if (e.key === 'deck-stage:presenter:nav') {
        try { this._handlePresenterMsg(JSON.parse(e.newValue)); } catch (_) {}
      }
    }

    _handlePresenterMsg(data) {
      if (!data) return;
      if (data.type === 'deck-nav') {
        if (data.action === 'next') this._go(this._index + 1, 'api');
        if (data.action === 'prev') this._go(this._index - 1, 'api');
      }
      if (data.type === 'deck-presenter-ready') {
        this._broadcastToPresenter();
      }
    }

    _presenterState() {
      return {
        type: 'deck-state',
        index: this._index,
        total: this._slides.length,
        notes: this._notes,

      };
    }

    _broadcastToPresenter() {
      const s = this._presenterState();
      if (this._bc) { try { this._bc.postMessage(s); } catch (_) {} }
      if (this._presenterWin && !this._presenterWin.closed) {
        try { this._presenterWin.postMessage(s, '*'); } catch (_) {}
      }
      try { localStorage.setItem('deck-stage:presenter:state', JSON.stringify(s)); } catch (_) {}
    }

    _togglePresenter() {
      if (this._presenterWin && !this._presenterWin.closed) {
        this._presenterWin.close();
        this._presenterWin = null;
        if (this._presenterBtn) this._presenterBtn.removeAttribute('data-active');
        if (this._presenterPollTimer) { clearInterval(this._presenterPollTimer); this._presenterPollTimer = null; }
        return;
      }
      this._openPresenter();
    }

    _openPresenter() {
      if (!this._presenterBlobURL) {
        const blob = new Blob([PRESENTER_HTML], { type: 'text/html' });
        this._presenterBlobURL = URL.createObjectURL(blob);
      }
      const pw = 420;
      const ph = Math.min(600, screen.height - 80);
      const pl = Math.round((screen.width  - pw) / 2);
      const pt = Math.round((screen.height - ph) / 2);
      this._presenterWin = window.open(
        this._presenterBlobURL, 'deck-presenter',
        `width=${pw},height=${ph},left=${pl},top=${pt},menubar=no,toolbar=no,location=no,status=no`
      );
      if (!this._presenterWin) {
        alert('[deck-stage] Pop-up was blocked.\nPlease allow pop-ups for this page, then press S again.');
        return;
      }
      if (this._presenterBtn) this._presenterBtn.setAttribute('data-active', '');
      // send state after short delays (window needs time to load)
      setTimeout(() => this._broadcastToPresenter(), 400);
      setTimeout(() => this._broadcastToPresenter(), 1200);
      // poll to detect when presenter window is closed
      if (this._presenterPollTimer) clearInterval(this._presenterPollTimer);
      this._presenterPollTimer = setInterval(() => {
        if (this._presenterWin && this._presenterWin.closed) {
          clearInterval(this._presenterPollTimer);
          this._presenterPollTimer = null;
          this._presenterWin = null;
          if (this._presenterBtn) this._presenterBtn.removeAttribute('data-active');
        }
      }, 800);
    }

    _cleanupPresenter() {
      if (this._bc) { try { this._bc.close(); } catch (_) {} this._bc = null; }
      if (this._presenterBlobURL) { URL.revokeObjectURL(this._presenterBlobURL); this._presenterBlobURL = null; }
      if (this._presenterWin && !this._presenterWin.closed) { try { this._presenterWin.close(); } catch (_) {} }
    }

    // ── Public API ────────────────────────────────────────────────────────

    get index()  { return this._index; }
    get length() { return this._slides.length; }
    goTo(i)  { this._go(i, 'api'); }
    next()   { this._go(this._index + 1, 'api'); }
    prev()   { this._go(this._index - 1, 'api'); }
    reset()  { this._go(0, 'api'); }
    openPresenter()  { this._openPresenter(); }
    closePresenter() {
      if (this._presenterWin && !this._presenterWin.closed) {
        this._presenterWin.close(); this._presenterWin = null;
        if (this._presenterBtn) this._presenterBtn.removeAttribute('data-active');
      }
    }
  }

  if (!customElements.get('deck-stage')) {
    customElements.define('deck-stage', DeckStage);
  }
})();
