/* One animation frame per scroll update; only visible scenes are painted. */
(function () {
  'use strict';
  var scenes = Array.from(document.querySelectorAll('.story-scene'));
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var visible = new Set();
  var frame = 0;
  function draw() {
    frame = 0;
    if (reduced.matches || document.hidden) return;
    visible.forEach(function (section) {
      var rect = section.getBoundingClientRect();
      var progress = Math.max(0, Math.min(1, (window.innerHeight - rect.top) / (window.innerHeight + rect.height)));
      section.querySelector('.story-image').style.transform = 'translate3d(0,' + ((progress - 0.5) * -1.8) + '%,0) scale(' + (1.02 + progress * 0.025) + ')';
    });
  }
  function schedule() { if (!frame && !reduced.matches && !document.hidden && visible.size) frame = requestAnimationFrame(draw); }
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) visible.add(entry.target); else visible.delete(entry.target);
        entry.target.classList.toggle('is-in-view', entry.isIntersecting && !reduced.matches);
      });
      schedule();
    });
    scenes.forEach(function (scene) { observer.observe(scene); });
  } else scenes.forEach(function (scene) { visible.add(scene); });
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  function reset() {
    cancelAnimationFrame(frame); frame = 0;
    scenes.forEach(function (scene) {
      scene.classList.toggle('is-in-view', visible.has(scene) && !reduced.matches && !document.hidden);
      if (reduced.matches) scene.querySelector('.story-image').style.transform = '';
    });
    schedule();
  }
  reduced.addEventListener('change', reset);
  document.addEventListener('visibilitychange', reset);
  schedule();
})();
