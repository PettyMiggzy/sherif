// ---- mobile nav ----
const toggle = document.getElementById('navToggle');
const links = document.getElementById('navLinks');
toggle.addEventListener('click', () => links.classList.toggle('open'));
links.addEventListener('click', (e) => { if (e.target.tagName === 'A') links.classList.remove('open'); });

// ---- nav bg on scroll ----
const nav = document.getElementById('nav');
const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 40);
onScroll();
addEventListener('scroll', onScroll, { passive: true });

// ---- copy contract ----
const copyBtn = document.getElementById('copyBtn');
const ca = document.getElementById('ca');
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(ca.textContent.trim());
    const old = copyBtn.textContent;
    copyBtn.textContent = 'Copied!';
    setTimeout(() => (copyBtn.textContent = old), 1500);
  } catch (_) { copyBtn.textContent = 'Copy failed'; }
});

// ---- animated counter ----
function runCounter(el) {
  const target = parseFloat(el.dataset.count);
  const dur = 1400, start = performance.now();
  const isInt = target % 1 === 0;
  function tick(now) {
    const p = Math.min((now - start) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    const v = target * e;
    el.textContent = isInt ? Math.round(v).toLocaleString() : v.toFixed(1);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ---- donut fill ----
function fillDonut(svg) {
  svg.querySelectorAll('.seg').forEach((s, i) => {
    setTimeout(() => { s.setAttribute('stroke-dasharray', s.dataset.dash); }, 120 * i);
  });
}

// ---- reveal + trigger counters/donut when in view ----
const io = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('in');
    entry.target.querySelectorAll?.('.count').forEach(runCounter);
    entry.target.querySelectorAll?.('.donut').forEach(fillDonut);
    io.unobserve(entry.target);
  });
}, { threshold: 0.15 });
document.querySelectorAll('.reveal').forEach((el, i) => {
  el.style.transitionDelay = `${(i % 4) * 70}ms`;
  io.observe(el);
});
