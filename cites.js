/* Citation carousel in act three (#science): the papers the source code cites, one card in front,
   the others fanned out to either side on a gentle arc. It turns every few seconds while on screen,
   stops while the pointer or focus is on it, and has buttons, arrow keys and swipe. With reduced
   motion it never turns by itself and cards move without animation. */
(function () {
  'use strict';
  var box = document.querySelector('[data-cites]');
  if (!box) return;
  var track = box.querySelector('.cites-track');
  var cards = Array.prototype.slice.call(track.children);
  var n = cards.length;
  var bar = box.querySelector('.cites-bar span');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var INTERVAL = 2800;
  var active = 0, timer = null, hold = false, onScreen = false, last = [];

  cards.forEach(function (c, i) { c.setAttribute('aria-roledescription', box.dataset.slide || 'paper'); c.setAttribute('aria-label', (i + 1) + ' / ' + n); });

  function layout() {
    var w = cards[0].offsetWidth;
    var narrow = window.innerWidth < 760;
    var step = w + (narrow ? 14 : 28);
    var tall = 0;
    // Every card gets the height of the tallest, so they all match.
    cards.forEach(function (c) { c.style.height = ''; tall = Math.max(tall, c.offsetHeight); });
    cards.forEach(function (c) { c.style.height = tall + 'px'; });
    cards.forEach(function (c, i) {
      var d = i - active;
      if (d > n / 2) d -= n;
      if (d < -n / 2) d += n;
      var a = Math.abs(d);
      // A card that wraps from one end to the other jumps without animation.
      c.style.transition = (last[i] !== undefined && Math.abs(last[i] - d) > 1) || reduce.matches ? 'none' : '';
      last[i] = d;
      var rot = d * (narrow ? 3 : 4.5);
      var y = a * a * (narrow ? 10 : 16) + a * 12;
      c.style.transform = 'translateX(-50%) translateX(' + (d * step) + 'px) translateY(' + y + 'px) rotate(' + rot + 'deg)';
      c.style.opacity = a > 2.2 ? '0' : a > 1.2 ? '0.75' : '1';
      c.style.zIndex = String(10 - a);
      c.classList.toggle('is-front', d === 0);
      c.setAttribute('aria-hidden', d === 0 ? 'false' : 'true');
    });
    track.style.height = (tall + (narrow ? 60 : 96)) + 'px';
    if (bar) bar.style.transform = 'scaleX(' + ((active + 1) / n) + ')';
  }

  function go(k) { active = (k % n + n) % n; layout(); restart(); }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function restart() {
    stop();
    if (reduce.matches || hold || !onScreen || document.hidden) return;
    timer = setInterval(function () { go(active + 1); }, INTERVAL);
  }

  box.querySelector('.cites-prev').addEventListener('click', function () { go(active - 1); });
  box.querySelector('.cites-next').addEventListener('click', function () { go(active + 1); });
  box.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { go(active - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { go(active + 1); e.preventDefault(); }
  });
  box.addEventListener('mouseenter', function () { hold = true; stop(); });
  box.addEventListener('mouseleave', function () { hold = false; restart(); });
  box.addEventListener('focusin', function () { hold = true; stop(); });
  box.addEventListener('focusout', function (e) { if (!box.contains(e.relatedTarget)) { hold = false; restart(); } });
  cards.forEach(function (c, i) { c.addEventListener('click', function () { if (i !== active) go(i); }); });

  var x0 = null;
  track.addEventListener('pointerdown', function (e) { x0 = e.clientX; });
  track.addEventListener('pointerup', function (e) {
    if (x0 === null) return;
    var dx = e.clientX - x0; x0 = null;
    if (Math.abs(dx) > 40) go(active + (dx < 0 ? 1 : -1));
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { onScreen = es[0].isIntersecting; restart(); }, { threshold: 0.35 }).observe(box);
  } else { onScreen = true; }
  document.addEventListener('visibilitychange', restart);
  if (reduce.addEventListener) reduce.addEventListener('change', function () { layout(); restart(); });
  window.addEventListener('resize', layout);
  layout();
  restart();
})();
