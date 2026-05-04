(function () {
  const slides = Array.from(document.querySelectorAll(".slide"));
  if (!slides.length) return;

  const counterEl = document.getElementById("counter");
  const progressEl = document.getElementById("progress");
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");

  let index = 0;

  function clamp(i) {
    if (i < 0) return 0;
    if (i > slides.length - 1) return slides.length - 1;
    return i;
  }

  function show(i) {
    index = clamp(i);
    slides.forEach((s, idx) => s.classList.toggle("active", idx === index));
    if (counterEl) counterEl.textContent = index + 1 + " / " + slides.length;
    if (progressEl) {
      const pct = ((index + 1) / slides.length) * 100;
      progressEl.style.width = pct + "%";
    }
    try {
      const url = new URL(window.location.href);
      url.hash = "s" + (index + 1);
      window.history.replaceState(null, "", url.toString());
    } catch (e) {}
  }

  function next() { show(index + 1); }
  function prev() { show(index - 1); }

  document.addEventListener("keydown", function (e) {
    if (["INPUT", "TEXTAREA"].indexOf(document.activeElement && document.activeElement.tagName) >= 0) return;
    switch (e.key) {
      case "ArrowRight":
      case "PageDown":
      case " ":
        e.preventDefault(); next(); break;
      case "ArrowLeft":
      case "PageUp":
        e.preventDefault(); prev(); break;
      case "Home":
        e.preventDefault(); show(0); break;
      case "End":
        e.preventDefault(); show(slides.length - 1); break;
    }
  });

  if (prevBtn) prevBtn.addEventListener("click", prev);
  if (nextBtn) nextBtn.addEventListener("click", next);

  // Touch support
  let touchStartX = null;
  document.addEventListener("touchstart", (e) => {
    if (e.touches && e.touches.length === 1) touchStartX = e.touches[0].clientX;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (touchStartX == null) return;
    const dx = (e.changedTouches[0].clientX - touchStartX);
    if (Math.abs(dx) > 60) { dx < 0 ? next() : prev(); }
    touchStartX = null;
  }, { passive: true });

  // Init from hash like #s3
  const hash = window.location.hash;
  let initial = 0;
  if (hash && /^#s\d+$/.test(hash)) {
    initial = parseInt(hash.slice(2), 10) - 1;
  }
  show(initial);
})();
