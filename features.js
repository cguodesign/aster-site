// #features: six expandable items, one open at a time, and one player for the open item's clip.
// - The clip autoplays muted while the player is on screen and pauses when it leaves.
// - When a clip ends, the next item opens, until the reader picks an item themselves.
// - Clips load on demand: the open item's clip, plus a prefetch of the next one.
// - Reduced motion: no autoplay; the poster shows with a play button.
// - Phones (<= 760px): the player moves under the open item.
(() => {
  const root = document.getElementById('features');
  if (!root) return;
  const items = [...root.querySelectorAll('.feat-list li')];
  const frame = root.querySelector('.feat-frame');
  const stage = root.querySelector('.feat-stage');
  const video = root.querySelector('.feat-video');
  const playBtn = root.querySelector('.feat-play');
  if (!items.length || !frame || !video) return;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const narrow = matchMedia('(max-width: 760px)');
  let active = 0;
  let userPicked = false;
  let near = false;      // section is close enough to start loading
  let visible = false;   // player is on screen

  items.forEach((li, i) => {
    const btn = li.querySelector('.feat-toggle');
    const body = li.querySelector('.feat-body');
    body.id = `feat-body-${i + 1}`;
    btn.setAttribute('aria-controls', body.id);
    btn.addEventListener('click', () => {
      userPicked = true;
      open(i, true);
    });
  });

  function place() {
    const slot = narrow.matches ? items[active].querySelector('.feat-inline') : stage;
    if (frame.parentElement !== slot) {
      slot.appendChild(frame); // moving a media element pauses it; update() resumes
    }
  }

  // The next clip is fetched whole into memory and played from there, so it is downloaded once.
  // (A <link rel="prefetch"> is not reused by the video element's own range requests.)
  const blobs = new Map(); // clip url -> Promise<object URL | null>
  const played = new Set(); // clips the player already streamed (the browser cache has them)
  function prefetch(url) {
    if (!url || blobs.has(url) || played.has(url)) return;
    blobs.set(url, fetch(url).then((r) => (r.ok ? r.blob() : null)).then((b) => b && URL.createObjectURL(b)).catch(() => null));
  }

  let loading = 0;
  async function load() {
    const li = items[active];
    const clip = li.dataset.clip;
    video.poster = li.dataset.poster;
    if (video.getAttribute('data-clip') === clip) { update(false); return; }
    video.setAttribute('data-clip', clip);
    played.add(clip);
    const ticket = ++loading;
    const blob = blobs.has(clip) ? await blobs.get(clip) : null;
    if (ticket !== loading) return; // another item was opened meanwhile
    video.src = blob || clip;
    video.preload = reduced.matches ? 'none' : 'auto'; // reduced motion: nothing loads until play
    update(false);
  }

  function setProgress(p) {
    items[active].style.setProperty('--p', p.toFixed(4));
  }

  function open(i, byUser) {
    items[active].style.removeProperty('--p');
    active = (i + items.length) % items.length;
    items.forEach((li, k) => {
      const on = k === active;
      li.classList.toggle('is-open', on);
      li.querySelector('.feat-toggle').setAttribute('aria-expanded', String(on));
    });
    place();
    if (byUser && video.getAttribute('data-clip') === items[active].dataset.clip) video.currentTime = 0;
    // load() calls update() once the clip is set; reduced motion then shows the poster and play button
    if (near) load(); else update(false);
  }

  function update(byUser) {
    const autoplay = !reduced.matches;
    if (!near || !visible || !video.getAttribute('src')) {
      video.pause();
      return;
    }
    if (autoplay || byUser) {
      const p = video.play();
      if (p && p.catch) p.catch(() => { playBtn.hidden = false; }); // e.g. low power mode
      playBtn.hidden = true;
    } else {
      video.pause();
      playBtn.hidden = false;
    }
  }

  // Progress line on the open item.
  let raf = 0;
  const tick = () => {
    if (video.duration) setProgress(video.currentTime / video.duration);
    raf = video.paused ? 0 : requestAnimationFrame(tick);
  };
  video.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); });
  video.addEventListener('canplaythrough', () => {
    prefetch(items[(active + 1) % items.length].dataset.clip);
  });
  video.addEventListener('ended', () => {
    setProgress(1);
    if (!userPicked && !reduced.matches) {
      open(active + 1, false);
    } else {
      playBtn.hidden = false;
    }
  });
  playBtn.addEventListener('click', () => {
    if (video.ended) video.currentTime = 0;
    update(true);
  });
  video.addEventListener('click', () => {
    if (video.paused) update(true); else { video.pause(); playBtn.hidden = false; }
  });

  // Start loading a little before the section arrives; play only while the player is visible.
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !near) { near = true; load(); }
  }, { rootMargin: '0px 0px 50% 0px' }).observe(root);
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    update(false);
  }, { threshold: 0.4 }).observe(frame);

  narrow.addEventListener('change', () => { place(); update(false); });
  reduced.addEventListener('change', () => update(false));
  open(0, false);
})();
