/* TAX GRAB — play the Sheriff, catch the loot, dodge the arrows. */
(() => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const wrap = document.getElementById('wrap');

  // ---------- assets ----------
  const FACES = {};
  const names = { idle: 'sheriff', listen: 'face-listen', scheme: 'face-scheme', shout: 'face-shout', nervous: 'face-nervous' };
  let loaded = 0;
  const total = Object.keys(names).length;
  for (const [k, f] of Object.entries(names)) {
    const im = new Image();
    im.onload = () => { loaded++; };
    im.src = `sprites/${f}.png`;
    FACES[k] = im;
  }

  // ---------- sizing ----------
  let W = 0, H = 0, DPR = 1, U = 1; // U = unit scale
  function resize() {
    const r = wrap.getBoundingClientRect();
    W = r.width; H = r.height; DPR = Math.min(devicePixelRatio || 1, 2);
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    U = Math.min(W, H) / 480; // scale reference
  }
  addEventListener('resize', resize); resize();

  // ---------- state ----------
  const S = { start: 0, play: 1, over: 2 };
  let state = S.start;
  let score = 0, combo = 1, lives = 3, elapsed = 0;
  let best = +(localStorage.getItem('sheriff_best') || 0);
  const items = [], parts = [], floats = [];
  let shake = 0, spawnT = 0, flash = 0;
  const player = { x: W / 2, tx: W / 2, y: 0, face: 'idle', faceT: 0, keyDir: 0 };

  // ---------- audio ----------
  let actx = null, muted = false;
  function AC() { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); return actx; }
  function beep(freq, dur, type = 'sine', gain = 0.06, slide = 0) {
    if (muted) return;
    try {
      const a = AC(), o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.value = freq;
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), a.currentTime + dur);
      g.gain.value = gain; g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
      o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + dur);
    } catch (e) {}
  }
  function noise(dur, gain = 0.05) {
    if (muted) return;
    try {
      const a = AC(), n = a.createBufferSource(), b = a.createBuffer(1, a.sampleRate * dur, a.sampleRate);
      const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      n.buffer = b; const g = a.createGain(); g.gain.value = gain;
      n.connect(g); g.connect(a.destination); n.start();
    } catch (e) {}
  }
  const sfxCoin = () => beep(880 + Math.random() * 120, 0.12, 'triangle', 0.05, 400);
  const sfxBag = () => { beep(500, 0.18, 'square', 0.05, 300); setTimeout(() => beep(760, 0.16, 'square', 0.05, 200), 60); };
  const sfxBill = () => beep(660, 0.1, 'sine', 0.045, 200);
  const sfxWhoosh = () => noise(0.18, 0.04);
  const sfxHit = () => { beep(150, 0.25, 'sawtooth', 0.08, -80); noise(0.2, 0.06); };
  const sfxOver = () => { [440, 350, 260, 180].forEach((f, i) => setTimeout(() => beep(f, 0.3, 'triangle', 0.06), i * 130)); };

  // ---------- quotes ----------
  const Q = {
    collect: ['Tax first. Ask questions never.', 'Your gold looks better in my vault.', "I don't steal. I collect.", 'Every road leads to my taxes.', 'The rich get richer.', 'Collect more.', 'Feed the Sheriff.'],
    combo: ["If you're smiling, you're not paying enough.", 'The Sheriff always wins.', 'Greed is law.', 'Tax everything.', 'Steal. Tax. Repeat.'],
    hit: ['Robin Hood is the criminal!', 'Your wallet is public property!', "That's assault on a tax officer!", 'The rich must be protected!'],
    over: ['Every road leads to my taxes.', 'The kingdom runs on taxes… and I own the kingdom.', 'Justice has a price.', 'Tax season never ends.', "Poor is a choice. Mine wasn't."],
  };
  const pick = (a) => a[(Math.random() * a.length) | 0];

  const bubble = document.getElementById('bubble');
  let bubbleT = 0;
  function say(text) {
    bubble.textContent = '“' + text + '”';
    bubble.style.left = Math.max(12, Math.min(W - 250, player.x - 30)) + 'px';
    bubble.style.top = (player.y - playerH() - 62) + 'px';
    bubble.classList.add('on'); bubbleT = 2.2;
  }

  // ---------- helpers ----------
  function playerH() { const im = FACES.idle; const w = 120 * U; return im.height ? w * im.height / im.width : w; }
  function setFace(f, t) { player.face = f; player.faceT = t; }
  function addFloat(x, y, text, color) { floats.push({ x, y, text, color, life: 1 }); }
  function burst(x, y, color, n = 10) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (60 + Math.random() * 160) * U;
      parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60 * U, life: .6 + Math.random() * .4, color, size: (2 + Math.random() * 3) * U });
    }
  }

  // ---------- spawning ----------
  function spawn() {
    const diff = Math.min(elapsed / 55, 1);
    const r = Math.random();
    let type;
    // arrow chance grows with difficulty
    const arrowP = 0.14 + diff * 0.20;
    if (r < arrowP) type = 'arrow';
    else if (r < arrowP + 0.10) type = 'bag';
    else if (r < arrowP + 0.30) type = 'bill';
    else type = 'coin';
    const size = ({ coin: 26, bill: 30, bag: 40, arrow: 30 })[type] * U;
    const speed = (300 + diff * 250 + Math.random() * 90) * U;
    items.push({ type, x: size + Math.random() * (W - size * 2), y: -size, vy: speed, size, rot: Math.random() * 6, vr: (Math.random() - .5) * 4 });
  }

  // ---------- input ----------
  function moveTo(clientX) {
    const r = canvas.getBoundingClientRect();
    player.tx = Math.max(0, Math.min(W, clientX - r.left));
    player.keyDir = 0;
  }
  canvas.addEventListener('pointermove', (e) => { if (state === S.play) moveTo(e.clientX); });
  canvas.addEventListener('pointerdown', (e) => { if (state === S.play) moveTo(e.clientX); });
  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') player.keyDir = -1;
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') player.keyDir = 1;
  });
  addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'a', 'A', 'ArrowRight', 'd', 'D'].includes(e.key)) player.keyDir = 0;
  });

  // ---------- game flow ----------
  const startScreen = document.getElementById('startScreen');
  const overScreen = document.getElementById('overScreen');
  const scoreBox = document.getElementById('scoreBox');
  const comboBox = document.getElementById('comboBox');
  const livesBox = document.getElementById('livesBox');

  function reset() {
    score = 0; combo = 1; lives = 3; elapsed = 0; spawnT = 0; shake = 0; flash = 0;
    items.length = 0; parts.length = 0; floats.length = 0;
    player.x = player.tx = W / 2; player.y = H - playerH() * 0.42; setFace('idle', 0);
    updateHUD();
  }
  function updateHUD() {
    scoreBox.innerHTML = score + '<small>Taxes</small>';
    comboBox.textContent = 'x' + combo;
    comboBox.classList.toggle('on', combo >= 2);
    livesBox.textContent = '🪙'.repeat(Math.max(0, lives)) + '<span style="opacity:.25">🪙</span>'.repeat(0);
    livesBox.textContent = '🪙'.repeat(Math.max(0, lives));
  }
  function start() { reset(); state = S.play; startScreen.classList.add('hidden'); overScreen.classList.add('hidden'); try { AC().resume(); } catch (e) {} }
  function gameOver() {
    state = S.over; sfxOver();
    best = Math.max(best, score); localStorage.setItem('sheriff_best', best);
    document.getElementById('finalScore').innerHTML = score + '<small>You collected</small>';
    document.getElementById('bestScore').innerHTML = best + '<small>Best haul</small>';
    document.getElementById('overQuote').textContent = '“' + pick(Q.over) + '”';
    overScreen.classList.remove('hidden');
  }
  document.getElementById('startBtn').onclick = start;
  document.getElementById('againBtn').onclick = start;
  document.getElementById('muteBtn').onclick = (e) => { muted = !muted; e.target.textContent = muted ? '🔇' : '🔊'; };

  // ---------- update ----------
  function catchItem(it) {
    if (it.type === 'arrow') {
      lives--; combo = 1; shake = 16 * U; flash = 0.5; sfxHit(); setFace('nervous', 0.7);
      say(pick(Q.hit)); burst(player.x, player.y - playerH() * 0.4, '#c0392b', 14);
      updateHUD();
      if (lives <= 0) gameOver();
      return;
    }
    let val = ({ coin: 1, bill: 3, bag: 5 })[it.type];
    const gain = val * combo;
    score += gain; combo++;
    const col = it.type === 'bill' ? '#8fe34a' : '#f5c542';
    burst(it.x, it.y, col, it.type === 'bag' ? 18 : 10);
    addFloat(it.x, it.y - 10 * U, '+' + gain, col);
    if (it.type === 'bag') { sfxBag(); setFace('scheme', 0.4); say(pick(Q.collect)); }
    else if (it.type === 'bill') { sfxBill(); setFace('scheme', 0.22); }
    else { sfxCoin(); setFace('scheme', 0.18); }
    if (combo === 5 || combo === 10 || combo % 20 === 0) { setFace('shout', 0.5); say(pick(Q.combo)); }
    else if (score > 0 && score % 60 < gain) say(pick(Q.collect));
    updateHUD();
  }

  function update(dt) {
    if (state !== S.play) return;
    elapsed += dt;
    // player movement
    if (player.keyDir) player.tx = Math.max(0, Math.min(W, player.tx + player.keyDir * 620 * U * dt));
    player.x += (player.tx - player.x) * Math.min(1, dt * 14);
    if (player.faceT > 0) { player.faceT -= dt; if (player.faceT <= 0) setFace('idle', 0); }
    // spawn
    spawnT -= dt;
    const rate = Math.max(0.34, 0.9 - elapsed * 0.012);
    if (spawnT <= 0) { spawn(); spawnT = rate; }
    // items — line-crossing catch (robust to fast items)
    const catchY = player.y - playerH() * 0.30;
    const half = 72 * U;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      const py = it.y;
      it.y += it.vy * dt; it.rot += it.vr * dt;
      const crossed = (py <= catchY && it.y >= catchY) || (it.y >= catchY && it.y <= catchY + 42 * U);
      if (crossed && Math.abs(it.x - player.x) < half) {
        catchItem(it); items.splice(i, 1); continue;
      }
      if (it.y > H + it.size * 2) {
        if (it.type !== 'arrow') { combo = 1; updateHUD(); } // missed loot resets combo
        items.splice(i, 1);
      }
    }
    // particles
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i]; p.life -= dt; p.vy += 520 * U * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.life <= 0) parts.splice(i, 1);
    }
    for (let i = floats.length - 1; i >= 0; i--) { const f = floats[i]; f.life -= dt * 1.4; f.y -= 40 * U * dt; if (f.life <= 0) floats.splice(i, 1); }
    if (shake > 0) shake = Math.max(0, shake - dt * 60 * U);
    if (flash > 0) flash = Math.max(0, flash - dt * 1.6);
    if (bubbleT > 0) { bubbleT -= dt; if (bubbleT <= 0) bubble.classList.remove('on'); }
  }

  // ---------- draw item shapes ----------
  function drawCoin(x, y, s) {
    ctx.save(); ctx.translate(x, y);
    const g = ctx.createRadialGradient(-s * .3, -s * .3, s * .1, 0, 0, s);
    g.addColorStop(0, '#ffe98a'); g.addColorStop(.6, '#f5c542'); g.addColorStop(1, '#c8901a');
    ctx.fillStyle = g; ctx.strokeStyle = '#8a5e12'; ctx.lineWidth = s * .1;
    ctx.beginPath(); ctx.arc(0, 0, s, 0, 7); ctx.fill(); ctx.stroke();
    // shield-arrow emblem
    ctx.strokeStyle = '#5da000'; ctx.lineWidth = s * .12; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-s * .28, s * .34); ctx.lineTo(s * .3, -s * .3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s * .3, -s * .3); ctx.lineTo(s * .08, -s * .26); ctx.moveTo(s * .3, -s * .3); ctx.lineTo(s * .26, -s * .06); ctx.stroke();
    ctx.restore();
  }
  function drawBill(x, y, s, rot) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot * .1);
    ctx.fillStyle = '#6fae3a'; ctx.strokeStyle = '#3f6d1c'; ctx.lineWidth = s * .08;
    roundRect(-s * 1.1, -s * .62, s * 2.2, s * 1.24, s * .18); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#eafff0'; ctx.font = `bold ${s * .9}px Bebas Neue, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('$', 0, s * .04);
    ctx.restore();
  }
  function drawBag(x, y, s, rot) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot * .05);
    ctx.fillStyle = '#c9a86a'; ctx.strokeStyle = '#5a4326'; ctx.lineWidth = s * .09;
    ctx.beginPath(); ctx.moveTo(-s * .8, -s * .5); ctx.quadraticCurveTo(-s * 1.05, s * .9, 0, s); ctx.quadraticCurveTo(s * 1.05, s * .9, s * .8, -s * .5);
    ctx.quadraticCurveTo(s * .3, -s * .3, 0, -s * .5); ctx.quadraticCurveTo(-s * .3, -s * .3, -s * .8, -s * .5); ctx.closePath(); ctx.fill(); ctx.stroke();
    // tie
    ctx.strokeStyle = '#5a4326'; ctx.lineWidth = s * .14; ctx.beginPath(); ctx.moveTo(-s * .55, -s * .42); ctx.quadraticCurveTo(0, -s * .1, s * .55, -s * .42); ctx.stroke();
    ctx.fillStyle = '#2a2113'; ctx.font = `bold ${s * .52}px Bebas Neue, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('TAX', 0, s * .34);
    // spill glint
    ctx.fillStyle = '#f5c542'; ctx.beginPath(); ctx.arc(-s * .2, -s * .48, s * .12, 0, 7); ctx.arc(s * .18, -s * .5, s * .1, 0, 7); ctx.fill();
    ctx.restore();
  }
  function drawArrow(x, y, s) {
    ctx.save(); ctx.translate(x, y);
    ctx.shadowColor = '#ccff00'; ctx.shadowBlur = s * .9;
    ctx.strokeStyle = '#b6ff2e'; ctx.fillStyle = '#ccff00'; ctx.lineWidth = s * .22; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, -s * 1.1); ctx.lineTo(0, s * .7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, s * 1.15); ctx.lineTo(-s * .5, s * .5); ctx.lineTo(s * .5, s * .5); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0; ctx.lineWidth = s * .16;
    ctx.beginPath(); ctx.moveTo(0, -s * 1.1); ctx.lineTo(-s * .34, -s * .7); ctx.moveTo(0, -s * 1.1); ctx.lineTo(s * .34, -s * .7); ctx.stroke();
    ctx.restore();
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

  // ---------- render ----------
  function render() {
    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - .5) * shake, (Math.random() - .5) * shake);
    // bg
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#141a0a'); bg.addColorStop(1, '#0a0d05');
    ctx.fillStyle = bg; ctx.fillRect(-40, -40, W + 80, H + 80);
    // subtle grid
    ctx.strokeStyle = 'rgba(204,255,0,.045)'; ctx.lineWidth = 1;
    const gs = 54 * U; for (let gx = 0; gx < W; gx += gs) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
    for (let gy = 0; gy < H; gy += gs) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
    // floor glow
    const fg = ctx.createRadialGradient(player.x, H, 10, player.x, H, 260 * U);
    fg.addColorStop(0, 'rgba(245,197,66,.16)'); fg.addColorStop(1, 'transparent');
    ctx.fillStyle = fg; ctx.fillRect(0, H - 300 * U, W, 300 * U);

    // items
    for (const it of items) {
      if (it.type === 'coin') drawCoin(it.x, it.y, it.size);
      else if (it.type === 'bill') drawBill(it.x, it.y, it.size, it.rot);
      else if (it.type === 'bag') drawBag(it.x, it.y, it.size, it.rot);
      else drawArrow(it.x, it.y, it.size);
    }
    // particles
    for (const p of parts) { ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
    // floats
    ctx.font = `bold ${20 * U}px Bebas Neue, sans-serif`; ctx.textAlign = 'center';
    for (const f of floats) { ctx.globalAlpha = Math.max(0, f.life); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y); }
    ctx.globalAlpha = 1;

    // player (sheriff)
    if (state !== S.start) {
      const im = FACES[player.face] && FACES[player.face].height ? FACES[player.face] : FACES.idle;
      if (im && im.height) {
        const pw = 120 * U, ph = pw * im.height / im.width;
        ctx.drawImage(im, player.x - pw / 2, player.y - ph / 2, pw, ph);
      }
    }

    // hit flash
    if (flash > 0) { ctx.fillStyle = `rgba(192,57,43,${flash * .4})`; ctx.fillRect(-40, -40, W + 80, H + 80); }
    ctx.restore();
  }

  // ---------- loop ----------
  let last = 0;
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000 || 0); last = t;
    update(dt); render();
    requestAnimationFrame(frame);
  }
  // set initial player position after first layout
  player.y = H - playerH() * 0.42;
  requestAnimationFrame(frame);
})();
