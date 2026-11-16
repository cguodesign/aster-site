/* Scroll controller for the study-room story (the .as-story block).

   .as-room: a sticky stage; scroll progress -> frame 1-451 -> three.js (room.js). The K7 sky then
   cross-fades into hero-airy inside a lavender mist.
   .as-descend: hero-airy lifts away, a parallax descent down forest-airy-tall to the reader under
   the tree, then the Aster title and the product. In the home page the block is followed by #plan
   (class story-joined): the descent ends exactly on #plan's picture, the title and product fade out
   and #plan's copy fades in where it sits, so the story turns into that section.
   Nothing heavy loads until the block is near the viewport. With prefers-reduced-motion the block
   shows key stills and never loads three.js. */

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const params = new URLSearchParams(location.search);

// Scroll budget per part of the shot, in screen heights. The warning hold (K3) gets a long
// stretch of its own so the pile of windows can be read.
const SEGMENTS = [
  { from: 1, to: 226, screens: 2.1, chapter: 'desk' },       // K0-K2: the desk, the timelapse, the push to the screen
  { from: 226, to: 301, screens: 1.5, chapter: 'too-much' }, // K3: "Too many windows are open." holds
  { from: 301, to: 451, screens: 1.7, chapter: 'window' },   // K4-K7: look up, open the window, fly out, sky
  { from: 451, to: 451, screens: 0.5 },                      // K7 sky cross-fades into hero-airy
];
// The descent (.as-descend, 340svh overlapping the room's last screen) is the 'landing' chapter.
// Whole story: about 9.2 screens.
const STORY_SCREENS = SEGMENTS.reduce((a, s) => a + s.screens, 0);
const PREFETCH_SCREENS = 2;   // load screen artwork this far ahead of the scroll position
const START_AHEAD = '0px 0px 100% 0px';   // start loading the 3D room one screen before it scrolls into view

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

function frameFromProgress(p) {
  let x = p * STORY_SCREENS;
  for (const s of SEGMENTS) {
    if (x <= s.screens) return s.from + (s.to - s.from) * (x / s.screens);
    x -= s.screens;
  }
  return SEGMENTS[SEGMENTS.length - 1].to;
}
function handoffFromProgress(p) {
  // 0 until the last segment, then 0 -> 1 across it (the 3D sky under hero-airy).
  const tail = SEGMENTS[SEGMENTS.length - 1].screens;
  const x = p * STORY_SCREENS - (STORY_SCREENS - tail);
  return Math.min(Math.max(x / (tail * 0.75), 0), 1);
}
function sectionProgress(el) {
  const r = el.getBoundingClientRect();
  const span = r.height - window.innerHeight;
  return span > 0 ? Math.min(Math.max(-r.top / span, 0), 1) : 0;
}

const box = document.querySelector('.as-story');
if (box) init(box);

function init(box) {
  const story = box.querySelector('.as-room');
  const descend = box.querySelector('.as-descend');
  const stage2 = descend.querySelector('.as-stage2');
  const hero = descend.querySelector('.as-hero');
  const forest = descend.querySelector('.as-forest');
  const intro = descend.querySelector('.as-intro');
  const product = descend.querySelector('.as-product');
  const video = product && product.querySelector('video');
  const forestImg = forest.querySelector('img');
  const copy = story.querySelector('.as-hero-copy');
  const progress = box.querySelector('.as-progress');
  const siteTop = document.querySelector('.site-top');
  // The opening copy and the progress bar sit under the fixed navigation.
  function topOffset() { box.style.setProperty('--as-top', (siteTop ? siteTop.offsetHeight : 0) + 'px'); }
  topOffset();
  window.addEventListener('resize', topOffset);
  // forest-airy-tall: fetched as soon as the room is up (or on idle), so it is decoded long before the
  // descent; until it is, hero-airy stays on and covers the stage.
  let forestReady = !!(forestImg && forestImg.complete && forestImg.naturalWidth && !forestImg.dataset.src);
  let forestLoading = false;
  function loadForest() {
    if (!forestImg || forestReady || forestLoading) return;
    forestLoading = true;
    if (forestImg.dataset.src) { forestImg.src = forestImg.dataset.src; delete forestImg.dataset.src; }
    else forestImg.loading = 'eager';                     // pages that still mark it lazy
    (forestImg.decode ? forestImg.decode() : Promise.resolve()).catch(() => {}).then(() => { forestReady = true; updateDescend(); });
  }
  const plan = box.nextElementSibling && box.nextElementSibling.classList.contains('story-joined') ? box.nextElementSibling : null;
  box.classList.toggle('as-joined', !!plan);
  // The tagline is written once, in the home page; the debug page borrows it.
  const tag = box.querySelector('#tagline[data-from-home]');
  if (tag) fetch(new URL('../', location.href)).then((r) => r.text()).then((html) => {
    const t = new DOMParser().parseFromString(html, 'text/html').querySelector('#tagline');
    if (t) tag.textContent = t.textContent;
  }).catch(() => {});
  story.style.setProperty('--as-screens', STORY_SCREENS + 1);

  /* ------------------------------------------------------------ where the descent lands
     The last frame lays forest-airy-tall over #plan's picture: same scale and crop (object-fit:
     cover with #plan's object-position), its lower half (a repaint of forest-airy) on top of it. */
  function landing(vw, vh) {
    let W = vw, H = vh, px = vw > 760 ? 0.85 : 0.88, py = 0.5;
    if (plan) {
      const pic = plan.querySelector('.story-picture'), img = plan.querySelector('.story-image');
      W = pic.clientWidth || vw; H = pic.clientHeight || vh;
      const pos = getComputedStyle(img).objectPosition.split(' ').map((v) => parseFloat(v) / 100);
      if (pos.length === 2 && pos.every((v) => !isNaN(v))) [px, py] = pos;
    }
    const s = Math.max(W / 1920, H / 1080);
    return { width: 1920 * s, x: (W - 1920 * s) * px, y: (H - 1080 * s) * py - 1080 * s };
  }

  let clone = null, cloneBg = [], cloneCopy = null, liveRoom = null;
  function ensureClone() {
    if (clone || !plan) return;
    clone = plan.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
    clone.classList.add('as-plan-clone');
    clone.setAttribute('aria-hidden', 'true');
    clone.inert = true;
    clone.querySelectorAll('img').forEach((im) => { im.loading = 'eager'; });
    cloneBg = [clone.querySelector('.story-picture'), clone.querySelector('.story-wash')].filter(Boolean);
    cloneCopy = clone.querySelector('.story-layout');
    stage2.insertBefore(clone, intro);
  }

  function updateDescend() {
    if (box.classList.contains('as-reduced')) return;
    const p = sectionProgress(descend);
    const vh = window.innerHeight, vw = window.innerWidth;
    const L = landing(vw, vh);
    if (p > 0 || descend.getBoundingClientRect().top < vh * 3) loadLate();
    // One painting all the way down: forest-airy-tall starts with its sky filling the stage and moves
    // up continuously until its meadow sits where #plan's picture is. It always covers the stage.
    const d = smooth(0.04, 0.62, p);
    forest.style.width = L.width + 'px';
    forest.style.transform = `translate3d(${L.x.toFixed(1)}px, ${(L.y * d).toFixed(1)}px, 0)`;
    forest.style.opacity = forestReady ? 1 : 0;
    // hero-airy only bridges the hand-off from the room (the descent starts over the room's last
    // screen, which shows the same picture): it dissolves in place into forest-airy-tall's own sky.
    const h = forestReady ? smooth(0.0, 0.16, p) : 0;
    hero.style.opacity = 1 - h;
    const out = plan ? 1 - smooth(0.80, 0.88, p) : 1;
    // Title over the empty sky. Home page: the main line comes in as the descent reaches the reader
    // and leaves before #plan's 01 does. Debug page: the old title card, held until the end.
    if (intro) {
      const [a0, a1, b0, b1] = plan ? [0.40, 0.48, 0.58, 0.64] : [0.60, 0.70, 0.80, 0.88];
      intro.style.opacity = smooth(a0, a1, p) * (plan ? 1 - smooth(b0, b1, p) : out);
      intro.style.transform = `translate3d(0, ${(1 - smooth(a0 - 0.02, a1 + 0.02, p)) * 40}px, 0)`;
    }
    if (product) {
      product.style.opacity = smooth(0.66, 0.74, p) * out;
      product.style.transform = `translate3d(0, ${(1 - smooth(0.64, 0.78, p)) * 60}px, 0)`;
    }
    if (plan && descend.getBoundingClientRect().top < vh * 2) {   // near: build the #plan copy
      ensureClone();
      clone.style.height = plan.offsetHeight + 'px';
      const bg = smooth(0.62, 0.70, p);              // repaint -> #plan's picture, in the mist
      cloneBg.forEach((e) => { e.style.opacity = bg; });
      cloneCopy.style.opacity = smooth(0.52, 0.62, p);   // act one's title comes in as the descent lands
    }
    // The descent overlaps the room's last screen: its stage stays hidden until it reaches the top
    // (at that moment it shows the same picture the room ends on). Past the end the stage and #plan
    // scroll together and look the same; hand over to the real section so its text can be selected.
    const dTop = descend.getBoundingClientRect().top;
    stage2.style.visibility = dTop > 0.5 || (plan && p >= 0.9995) ? 'hidden' : '';
  }

  /* ------------------------------------------------------------ product video (muted loop) */
  if (video && reduce.matches && video.dataset.poster) video.poster = video.dataset.poster;   // still frame only
  if (video && !reduce.matches) {
    new IntersectionObserver((es) => {
      const on = es[0].isIntersecting;
      if (on && !video.src && video.dataset.src) { video.poster = video.dataset.poster || ''; video.src = video.dataset.src; }
      if (on) video.play().catch(() => {}); else video.pause();
    }, { rootMargin: '25% 0px' }).observe(stage2);
  }

  /* ------------------------------------------------------------ reduced motion: stills */
  function stillsMode() {
    box.classList.add('as-reduced');
    box.classList.remove('as-live');
    [hero, forest, intro, product, copy].forEach((e) => { if (e) e.style.cssText = ''; });
    loadLate();
    const stills = story.querySelector('.as-stills');
    if (progress && stills) stills.before(progress);       // the chapter list sits above the stills
    stage2.style.visibility = '';
  }

  /* ------------------------------------------------------------ live mode */
  async function liveMode() {
    box.classList.add('as-live');
    const canvas = story.querySelector('canvas');
    const stage = story.querySelector('.as-stage');
    const status = story.querySelector('.as-status');
    let room;
    try {
      const { createRoom } = await import('./room.js?v=20261116a');   // bump with index.html's ?v=
      room = await createRoom(canvas, { shadows: params.get('shadows') || 'auto', onProgress: (x) => { status.textContent = `${status.dataset.loading || '正在载入房间'} ${Math.round(x * 100)}%`; } });
    } catch (e) {
      console.error(e);
      status.textContent = '';
      return stillsMode();
    }
    status.textContent = '';
    window.__room = room;
    liveRoom = room;
    if (copy) room.setOpening(1 - smooth(0, 0.35 / STORY_SCREENS, sectionProgress(story)));
    box.dataset.shadows = room.shadowTier;

    let target = 1, current = 1, raf = 0, last = 0, visible = true, dirty = true;
    const fixed = params.has('frame') ? parseFloat(params.get('frame')) : null;
    if (fixed != null) box.classList.add('as-still');
    const dprCap = parseFloat(params.get('dpr')) || 2;

    function size() {
      room.resize(stage.clientWidth, stage.clientHeight, Math.min(window.devicePixelRatio || 1, dprCap));
      dirty = true;
    }
    const handoff = story.querySelector('.as-handoff');
    const fog = story.querySelector('.as-fog');
    const forcedHandoff = params.has('handoff') ? parseFloat(params.get('handoff')) : null;
    function setHandoff(h) {
      // Mist rises to 70 % at the midpoint and clears again; the painting comes in only while the
      // mist is thick (h 0.38-0.62), so cartoon and painted clouds are never seen together.
      fog.style.opacity = (0.7 * Math.sin(Math.PI * h) ** 1.5).toFixed(3);
      fog.style.transform = `translate3d(0, ${(-2 * h).toFixed(2)}%, 0) scale(${(1 + 0.04 * h).toFixed(3)})`;
      handoff.style.opacity = smooth(0.38, 0.62, h).toFixed(3);
    }
    function readScroll(e) {
      const p = sectionProgress(story);
      target = fixed ?? frameFromProgress(p);
      setHandoff(forcedHandoff ?? (fixed != null ? 0 : handoffFromProgress(p)));
      // First screen: only what K0-K1 shows (room.js loads it). Once the reader scrolls, or the
      // block is already part-way through, fetch the screen artwork needed up to 2 screens ahead.
      if (e || p > 0) room.prefetch(fixed ?? frameFromProgress(Math.min(1, p + PREFETCH_SCREENS / STORY_SCREENS)));
      kick();
    }
    function kick() { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick); }
    const stats = { frames: 0, t0: performance.now(), times: [] };
    window.__storyStats = stats;
    function tick(now) {
      raf = 0;
      const dt = last ? Math.min((now - last) / 1000, 0.1) : 1 / 60;
      last = now;
      const d = target - current;
      // Ease toward the scroll position: smooth on a wheel, exact when it settles.
      current = Math.abs(d) < 0.02 || fixed != null ? target : current + d * Math.min(1, dt * 9);
      if (dirty || d !== 0) {
        const t = performance.now();
        room.setFrame(current);
        room.render();
        stats.times.push(performance.now() - t);
        if (stats.times.length > 600) stats.times.shift();
        stats.frames++;
        dirty = false;
        box.style.setProperty('--as-frame', current.toFixed(2));
        story.dataset.frame = current.toFixed(1);
      }
      if (current !== target) kick(); else last = 0;
    }
    room.onNeedsRender = () => { dirty = true; kick(); };

    // Stop rendering when the stage is off screen or the tab is hidden.
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) { dirty = true; kick(); } }, { rootMargin: '10% 0px' }).observe(stage);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { dirty = true; kick(); } });
    window.addEventListener('resize', () => { size(); readScroll(); });
    window.addEventListener('scroll', readScroll, { passive: true });
    size();
    readScroll();
    current = target;
    // Fade in from the page colour (the video fades in from black over the first half second).
    requestAnimationFrame(() => box.classList.add('as-ready'));
    window.__storyReady = true;

  }

  /* ------------------------------------------------------------ opening copy and progress bar */
  const chapters = progress ? [...progress.querySelectorAll('[data-chapter]')] : [];
  const bar = progress && progress.querySelector('.as-progress-bar');
  const fill = progress && progress.querySelector('.as-progress-fill');
  function storyRange() {
    const top = scrollY + story.getBoundingClientRect().top;
    const roomSpan = story.offsetHeight - innerHeight;
    const dTop = scrollY + descend.getBoundingClientRect().top;
    const end = dTop + descend.offsetHeight - innerHeight;
    let x = 0;
    const at = { };   // where each chapter starts (for the bar's spoken value)
    for (const seg of SEGMENTS) { if (seg.chapter) at[seg.chapter] = top + roomSpan * x / STORY_SCREENS; x += seg.screens; }
    at.landing = dTop + (descend.offsetHeight - innerHeight) * 0.3;
    return { start: top, end, at };
  }
  // Pictures for the end of the room and the descent: fetched once the room is 30 % through (two
  // screens or more before they show), so they stay out of the first load.
  let lateLoaded = false;
  function loadLate() {
    if (lateLoaded) return;
    lateLoaded = true;
    box.querySelectorAll('.as-handoff[data-src], .as-hero img[data-src]').forEach((im) => { im.src = im.dataset.src; delete im.dataset.src; });
    loadForest();
  }
  function updateChrome() {
    const y = scrollY, vh = innerHeight;
    const roomP = sectionProgress(story);
    if (roomP > 0.3 || descend.getBoundingClientRect().top < vh * 3) loadLate();
    if (copy && !box.classList.contains('as-reduced')) {
      // The headline and waitlist fade over the first third of a screen of scrolling.
      const c = 1 - smooth(0, 0.35 / STORY_SCREENS, roomP);
      copy.style.opacity = c.toFixed(3);
      copy.style.visibility = c < 0.02 ? 'hidden' : '';
      box.style.setProperty('--as-copy', c.toFixed(3));
      if (liveRoom && liveRoom.setOpening) { liveRoom.setOpening(c); liveRoom.onNeedsRender && liveRoom.onNeedsRender(); }
    }
    if (!progress || box.classList.contains('as-reduced')) return;
    const R = storyRange();
    const t = Math.min(Math.max((y - R.start) / (R.end - R.start), 0), 1);
    const on = y > R.start + vh * 0.2 && y < R.end + vh * 0.25;
    progress.classList.toggle('on', on);
    fill.style.transform = `scaleX(${t.toFixed(4)})`;
    let current = chapters[0];
    for (const a of chapters) if (y >= R.at[a.dataset.chapter] - 2) current = a;
    const pct = String(Math.round(t * 100));
    if (bar.getAttribute('aria-valuenow') !== pct) {
      bar.setAttribute('aria-valuenow', pct);
      bar.setAttribute('aria-valuetext', `${current.textContent} · ${pct}%`);
    }
  }
  // The bar: click or drag to a point in proportion (no snapping to chapters); keys step through.
  function seek(t, smoothly) {
    const R = storyRange();
    window.scrollTo({ top: Math.round(R.start + Math.min(Math.max(t, 0), 1) * (R.end - R.start)), behavior: smoothly ? 'smooth' : 'instant' });
  }
  if (bar) {
    const tAt = (e) => { const r = bar.getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
    let dragging = false, moved = false;
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true; moved = false;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
    });
    bar.addEventListener('pointermove', (e) => { if (dragging) { moved = true; seek(tAt(e), false); } });
    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      bar.classList.remove('dragging');
      if (!moved && e.type === 'pointerup') seek(tAt(e), true);   // a plain click glides there
    };
    bar.addEventListener('pointerup', stop);
    bar.addEventListener('pointercancel', stop);
    bar.addEventListener('keydown', (e) => {
      const now = (+bar.getAttribute('aria-valuenow') || 0) / 100;
      const step = { ArrowRight: 0.02, ArrowUp: 0.02, ArrowLeft: -0.02, ArrowDown: -0.02, PageDown: 0.1, PageUp: -0.1 }[e.key];
      if (step !== undefined) seek(now + step, false);
      else if (e.key === 'Home') seek(0, false);
      else if (e.key === 'End') seek(1, false);
      else return;
      e.preventDefault();
    });
  }

  window.addEventListener('scroll', updateDescend, { passive: true });
  window.addEventListener('resize', updateDescend);
  window.addEventListener('scroll', updateChrome, { passive: true });
  window.addEventListener('resize', updateChrome);
  updateDescend();
  updateChrome();

  if (reduce.matches || params.has('reduced')) stillsMode();
  else {
    // Load three.js, the GLB and the timeline only when the block comes near the viewport.
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        const poster = story.querySelector('.as-poster[data-src]');   // first frame, shown while loading
        if (poster) poster.src = poster.dataset.src;
        liveMode();
      }
    }, { rootMargin: START_AHEAD });
    io.observe(story);
  }
  // Switching the setting while the page is open: the simplest correct thing is a reload.
  reduce.addEventListener?.('change', () => location.reload());
}
