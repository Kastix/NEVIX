const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { games: [], settings: {}, view: 'home', q: '', status: {}, gameActive: false };
const ACCENTS = ['#22d3ee', '#3b82f6', '#2dd4bf', '#38bdf8', '#4ade80'];

function toast(msg, err) {
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3600);
}
function apply(r) {
  if (!r) return; if (r.games) S.games = r.games; if (r.settings) S.settings = r.settings;
  document.documentElement.style.setProperty('--accent', S.settings.accent || '#22d3ee');
  syncPerf();
}
const hue = n => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return 175 + (h % 60); }; // cyan-blue range only
const art = n => `linear-gradient(135deg,hsl(${hue(n)},70%,24%),hsl(${hue(n) + 25},75%,10%))`;
const ago = t => {
  if (!t) return 'Never';
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'Just now'; if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60); if (h < 24) return h + ' h ago';
  const d = Math.floor(h / 24); return d < 30 ? d + ' d ago' : new Date(t).toLocaleDateString();
};
const filtered = list => { const q = S.q.trim().toLowerCase(); return q ? list.filter(g => g.name.toLowerCase().includes(q)) : list; };

const gameArt = g => g.hasIcon ? `<img class="gicon" src="nevix-icon://${g.id}/?v=${g.hasIcon}" alt="">` : `<span>${esc(g.name.charAt(0).toUpperCase())}</span>`;
function card(g) {
  const st = S.status[g.id] || (g.running ? { t: 'Running', c: 'run' } : { t: 'Ready', c: '' });
  const busy = st.t === 'Launching...' || st.t === 'Fixing...';
  return `<div class="card" data-id="${g.id}">
    <div class="art" style="--art:${art(g.name)}">${gameArt(g)}</div>
    <button class="star ${g.favorite ? 'on' : ''}" data-act="fav" title="Favorite">${g.favorite ? '★' : '☆'}</button>
    <div class="info"><h4>${esc(g.name)}</h4>
      <div class="meta"><span class="status ${st.c}">${esc(st.t)}</span><span>${ago(g.lastLaunched)}</span></div>
      <button class="btn primary launch ${busy ? 'busy' : ''}" data-act="launch">${st.t === 'Fixing...' ? 'FIXING' : busy ? 'LAUNCHING' : 'LAUNCH'}</button>
      ${st.missing ? '<div class="mini"><button class="btn" data-act="relocate">LOCATE EXE</button></div>' : ''}
      <div class="mini"><button class="btn ghost" data-act="rename">RENAME</button><button class="btn ghost" data-act="icon">ICON</button><button class="btn danger" data-act="remove">REMOVE</button></div>
    </div></div>`;
}
const addCard = '<div class="card add-card" data-act="add"><div><b>+</b>ADD GAME<small>or drop a shortcut anywhere</small></div></div>';
const addBtn = '<div class="row"><button class="btn ghost" data-act="scan">SCAN PC</button><button class="btn" data-act="add">+ ADD GAME</button></div>';

function updateEyebrow() { const n = (S.settings.userName || '').trim(); $('#eyebrow').textContent = 'WELCOME BACK' + (n ? ', ' + n.toUpperCase() : ''); }
function render() {
  updateEyebrow();
  const v = $('#view'); let h = '';
  if (S.view === 'home') {
    const f = [...S.games].sort((a, b) => (b.lastLaunched || 0) - (a.lastLaunched || 0))[0];
    h = f ? `<div class="featured" style="--art:${art(f.name)}" data-id="${f.id}">${f.hasIcon ? `<img class="f-icon" src="nevix-icon://${f.id}/?v=${f.hasIcon}" alt="">` : ''}<div class="tag">${f.lastLaunched ? 'LAST PLAYED' : 'FEATURED'}</div><h3>${esc(f.name)}</h3><p>${f.launches ? `Launched ${f.launches} time${f.launches > 1 ? 's' : ''} from NEVIX.` : 'Ready to play. Hit PLAY to start your game.'}</p><div class="row"><button class="btn primary" data-act="launch">▶ PLAY</button><button class="btn ghost" data-act="details">DETAILS</button></div></div>`
      : `<div class="featured"><div class="tag">GET STARTED</div><h3>Welcome to NEVIX</h3><p>Add your first game by choosing its .exe file. It will appear in your library and you can launch it with one click.</p><div class="row"><button class="btn primary" data-act="add">+ ADD GAME</button></div></div>`;
    const list = filtered(S.games);
    h += `<div class="sec-title"><h2>MY GAMES</h2>${addBtn}</div>` + (list.length ? `<div class="grid">${list.map(card).join('')}${S.q ? '' : addCard}</div>` : `<div class="empty">${S.q ? 'No games match your search.' : 'Your library is empty.<br>Tip: drag a game shortcut or .exe anywhere in this window to add it.'}</div>`);
  } else if (S.view === 'favorites') {
    const list = filtered(S.games.filter(g => g.favorite));
    h = `<div class="sec-title"><h2>FAVORITES</h2></div>` + (list.length ? `<div class="grid">${list.map(card).join('')}</div>` : '<div class="empty">No favorites yet. Click ☆ on a game to pin it here.</div>');
  } else if (S.view === 'stats') h = statsView();
  else h = settingsView();
  v.innerHTML = h;
}

function statsView() {
  const g = S.games, total = g.reduce((a, x) => a + (x.launches || 0), 0);
  const last = [...g].filter(x => x.lastLaunched).sort((a, b) => b.lastLaunched - a.lastLaunched)[0];
  const top = [...g].sort((a, b) => (b.launches || 0) - (a.launches || 0))[0];
  const max = Math.max(1, ...g.map(x => x.launches || 0));
  return `<div class="sec-title"><h2>STATISTICS</h2></div><div class="stats">
    <div class="stat"><small>GAMES</small><div>${g.length}</div></div>
    <div class="stat"><small>TOTAL LAUNCHES</small><div>${total}</div></div>
    <div class="stat"><small>LAST PLAYED</small><div>${last ? esc(last.name) : '—'}</div></div>
    <div class="stat"><small>FAVORITES</small><div>${g.filter(x => x.favorite).length}</div></div>
    <div class="stat"><small>MOST PLAYED</small><div>${top && top.launches ? esc(top.name) : '—'}</div></div></div>
    <div class="chart"><small style="letter-spacing:.25em;color:var(--dim);font-size:10px">LAUNCHES PER GAME</small>
    ${g.length ? [...g].sort((a, b) => (b.launches || 0) - (a.launches || 0)).map(x => `<div class="crow"><span>${esc(x.name)}</span><div class="cbar"><b style="width:${(x.launches || 0) / max * 100}%"></b></div><span>${x.launches || 0}</span></div>`).join('') : '<div class="empty">Add games to see charts.</div>'}</div>`;
}
function settingsView() {
  const s = S.settings, tg = (k, l, d) => `<div class="srow"><div>${l}<small>${d}</small></div><button class="tg ${s[k] ? 'on' : ''}" data-set="${k}"></button></div>`;
  return `<div class="set"><div class="sec-title"><h2>PROFILE</h2></div>
    <div class="srow"><div>Your name<small>Shown on the welcome screen</small></div><input id="nameIn" class="txt" maxlength="24" placeholder="Enter your name" value="${esc(s.userName || '')}"></div>
    <div class="sec-title"><h2>APPEARANCE</h2></div>
    <div class="srow"><div>Accent color<small>Applies instantly</small></div><div class="swatches">${ACCENTS.map(c => `<div class="sw ${s.accent === c ? 'on' : ''}" data-accent="${c}" style="background:${c}"></div>`).join('')}</div></div>
    ${tg('animatedBg', 'Animated background', 'Twinkling stars and shooting stars (turn off to save CPU/GPU)')}
    <div class="sec-title"><h2>LAUNCHER</h2></div>
    ${tg('startWithWindows', 'Start with Windows', 'Open NEVIX when you sign in')}
    ${tg('minimizeToTray', 'Minimize to tray', 'Closing the window keeps NEVIX in the system tray')}
    ${tg('gameMode', 'Game Mode', 'While a game runs: pause animations and lower NEVIX priority')}
    ${tg('gameModeMinimize', 'Minimize when a game starts', 'Gets NEVIX out of the way automatically')}
    <div class="sec-title"><h2>LIBRARY</h2></div>
    <div class="srow"><div>Scan PC for games<small>Finds installed games (Steam, Epic, GOG, Riot, Xbox and common game folders)</small></div><button class="btn" data-act="scan">SCAN NOW</button></div></div>`;
}

function modal(html, cls = '') { const m = $('#modal'); m.innerHTML = `<div class="dlg ${cls}">${html}</div>`; m.classList.remove('hidden'); }
const closeModal = () => $('#modal').classList.add('hidden');
const ask = (title, sub, val) => new Promise(res => {
  modal(`<h3>${esc(title)}</h3><p>${esc(sub)}</p><input id="mi" value="${esc(val)}" maxlength="60"><div class="row"><button class="btn ghost" id="mc">CANCEL</button><button class="btn primary" id="mo">SAVE</button></div>`);
  const i = $('#mi'); i.focus(); i.select();
  const end = v => { closeModal(); res(v); };
  $('#mc').onclick = () => end(null); $('#mo').onclick = () => end(i.value);
  i.onkeydown = e => { if (e.key === 'Enter') end(i.value); if (e.key === 'Escape') end(null); };
});

async function runScan(auto) {
  modal('<h3>Scanning your PC...</h3><p>Looking for installed games. This can take a moment.</p><div class="spin"></div>');
  let r; try { r = await nevix.scan(); } catch (e) { r = { error: 'Scan failed. You can still add games manually.' }; }
  if (auto) apply(await nevix.setSettings({ firstScanDone: true }));
  if (r.error) { closeModal(); return toast(r.error, true); }
  if (!r.found.length) {
    modal('<h3>No new games found</h3><p>Nothing was detected automatically. You can add games yourself with + ADD GAME.</p><div class="row"><button class="btn primary" id="mc">OK</button></div>');
    $('#mc').onclick = closeModal; return;
  }
  modal(`<h3>Found ${r.found.length} game${r.found.length > 1 ? 's' : ''}</h3><p>Choose which ones to add to your library.</p><div class="picks">${r.found.map((g, i) => `<label class="pick"><input type="checkbox" checked data-i="${i}"><span><b>${esc(g.name)}</b><small>${g.steamId ? 'Steam' + (g.path ? ' • ' : '') : ''}${esc(g.path || '')}</small></span></label>`).join('')}</div><div class="row"><button class="btn ghost" id="mc">SKIP</button><button class="btn primary" id="mo">ADD SELECTED</button></div>`, 'wide');
  $('#mc').onclick = closeModal;
  $('#mo').onclick = async () => {
    const items = [...document.querySelectorAll('.pick input:checked')].map(c => r.found[+c.dataset.i]);
    closeModal(); if (!items.length) return;
    const res = await nevix.addMany(items);
    if (res.error) return toast(res.error, true);
    apply(res); render(); toast(`${res.added} game${res.added === 1 ? '' : 's'} added to your library`);
  };
}
async function addGame() {
  const p = await nevix.pickExe();
  if (p.canceled) return; if (p.error) return toast(p.error, true);
  const name = await ask('Name your game', p.path, p.name); if (name === null) return;
  const r = await nevix.addGame({ path: p.path, name });
  if (r.error) return toast(r.error, true);
  apply(r); render(); toast(`${name.trim() || p.name} added to your library`);
}
async function launch(id, tries = 0) {
  const g0 = S.games.find(x => x.id === id);
  S.status[id] = { t: 'Launching...', c: '' }; render();
  const r = await nevix.launch(id);
  if (r.error) {
    S.status[id] = { t: r.error, c: 'err', missing: true }; render();
    if (r.needsLocate && tries < 1) { // auto-fix failed: ask for the location right away
      toast(`Couldn't start ${g0 ? g0.name : 'the game'} automatically. Please point me to its .exe.`, true);
      const rl = await nevix.relocate(id);
      if (rl.ok) { apply(rl); delete S.status[id]; render(); return launch(id, tries + 1); }
    } else toast(r.error, true);
    return;
  }
  apply(r);
  if (r.note) toast(r.note);
  if (r.shell) {
    S.status[id] = { t: 'Started', c: 'run' };
    setTimeout(() => { if (S.status[id] && S.status[id].t === 'Started') { delete S.status[id]; render(); } }, 8000);
  } else S.status[id] = { t: 'Running', c: 'run' };
  render();
}
async function relocate(id) {
  const r = await nevix.relocate(id); if (r.canceled) return; if (r.error) return toast(r.error, true);
  apply(r); delete S.status[id]; render(); toast('Executable updated');
}

document.addEventListener('click', async e => {
  const nav = e.target.closest('.nav');
  if (nav) { S.view = nav.dataset.view; document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n === nav)); return render(); }
  const set = e.target.closest('[data-set]');
  if (set) { apply(await nevix.setSettings({ [set.dataset.set]: !S.settings[set.dataset.set] })); return render(); }
  const ac = e.target.closest('[data-accent]');
  if (ac) { apply(await nevix.setSettings({ accent: ac.dataset.accent })); return render(); }
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = (b.closest('[data-id]') || {}).dataset?.id, act = b.dataset.act;
  if (act === 'add') return addGame();
  if (act === 'scan') return runScan(false);
  if (act === 'launch') return launch(id);
  if (act === 'icon') { const r = await nevix.setIcon(id); if (r.canceled) return; if (r.error) return toast(r.error, true); apply(r); render(); return toast('Icon updated'); }
  if (act === 'relocate') return relocate(id);
  if (act === 'details') { const g = S.games.find(x => x.id === id); return modal(`<h3>${esc(g.name)}</h3><p>${esc(g.path || '')}<br><br>Launch: ${/^steam:/i.test(g.url || '') ? 'via Steam' : g.url ? 'via launcher link' : 'direct .exe'}<br>Launches: ${g.launches || 0}<br>Last played: ${ago(g.lastLaunched)}</p><div class="row"><button class="btn primary" id="mc">CLOSE</button></div>`), $('#mc').onclick = closeModal; }
  if (act === 'fav') { apply(await nevix.toggleFav(id)); return render(); }
  if (act === 'remove') { const g = S.games.find(x => x.id === id); modal(`<h3>Remove ${esc(g.name)}?</h3><p>This only removes it from NEVIX. The game stays on your PC.</p><div class="row"><button class="btn ghost" id="mc">CANCEL</button><button class="btn danger" id="mo">REMOVE</button></div>`); $('#mc').onclick = closeModal; $('#mo').onclick = async () => { closeModal(); apply(await nevix.remove(id)); render(); }; return; }
  if (act === 'rename') { const g = S.games.find(x => x.id === id); const n = await ask('Rename game', g.path || '', g.name); if (n) { apply(await nevix.rename(id, n)); render(); } }
});
$('#search').addEventListener('input', e => { S.q = e.target.value; if (S.view === 'stats' || S.view === 'settings') { S.view = 'home'; document.querySelectorAll('.nav').forEach(n => n.classList.toggle('active', n.dataset.view === 'home')); } render(); });
let nameTimer; document.addEventListener('input', e => { if (e.target.id !== 'nameIn') return; clearTimeout(nameTimer); const v = e.target.value; nameTimer = setTimeout(async () => { apply(await nevix.setSettings({ userName: v })); updateEyebrow(); }, 400); });
$('#wMin').onclick = () => nevix.win.min(); $('#wMax').onclick = () => nevix.win.max(); $('#wClose').onclick = () => nevix.win.close();
nevix.onStatus(({ id, text }) => { S.status[id] = { t: text, c: '' }; render(); });
nevix.onLibChanged(r => { apply(r); render(); });
nevix.onGameExit(id => { const g = S.games.find(x => x.id === id); if (g) g.running = false; delete S.status[id]; render(); });

// Quick Drop: drag shortcuts / exe anywhere in the window
let dragN = 0;
const dz = () => $('#dropzone'), hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragN++; dz().classList.add('show'); });
addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
addEventListener('dragleave', e => { if (!hasFiles(e)) return; dragN = Math.max(0, dragN - 1); if (!dragN) dz().classList.remove('show'); });
addEventListener('drop', async e => {
  if (!hasFiles(e)) return; e.preventDefault(); dragN = 0; dz().classList.remove('show');
  const paths = [...e.dataTransfer.files].map(f => nevix.getDropPath(f)).filter(Boolean);
  if (!paths.length) return toast('Could not read the dropped file.', true);
  const r = await nevix.dropAdd(paths);
  if (r.games) { apply(r); render(); }
  if (r.added) toast(`${r.added} game${r.added > 1 ? 's' : ''} added`);
  else if (r.skipped && !r.errors.length) toast('Already in your library');
  (r.errors || []).slice(0, 2).forEach(m => toast(m, true));
});

// system monitor (CPU/RAM real; FPS = this launcher's real render rate)
const setBar = (b, t, p, txt) => { $(b).style.width = p + '%'; $(t).textContent = txt; };
const isPaused = () => S.gameActive && S.settings.gameMode !== false && !document.hasFocus();
function showGpu(g) {
  const row = $('#gpuRow');
  if (!g) return setBar('#gpuB', '#gpuT', 0, '...');
  if (g.unavailable) { row.title = 'GPU stats are not available on this PC'; return setBar('#gpuB', '#gpuT', 0, 'N/A'); }
  setBar('#gpuB', '#gpuT', g.usage, g.usage + '%' + (g.temp != null ? ' ' + g.temp + '\u00b0C' : ''));
  row.title = (g.name || 'GPU') + (g.vramTotalMB ? ` \u2022 VRAM ${g.vramUsedMB}/${g.vramTotalMB} MB` : '');
}
setInterval(async () => {
  if (isPaused()) return;
  try { const s = await nevix.stats(); setBar('#cpuB', '#cpuT', s.cpu, s.cpu + '%'); setBar('#ramB', '#ramT', s.ram, `${s.ramUsedGB}/${s.ramTotalGB}G`); showGpu(s.gpu); } catch (_) {}
}, 1500);
let frames = 0, t0 = performance.now(), fpsRaf = 0;
function fpsLoop(t) { frames++; if (t - t0 >= 1000) { const f = Math.round(frames * 1000 / (t - t0)); setBar('#fpsB', '#fpsT', Math.min(100, f / 60 * 100), f); frames = 0; t0 = t; } fpsRaf = requestAnimationFrame(fpsLoop); }
function fpsStart() { if (!fpsRaf) { frames = 0; t0 = performance.now(); fpsRaf = requestAnimationFrame(fpsLoop); } }
function fpsStop() { cancelAnimationFrame(fpsRaf); fpsRaf = 0; }
fpsStart();

// Game Mode: while a game runs and NEVIX is not the focused window, freeze animations, effects and polling
function syncPerf() {
  const p = isPaused();
  document.body.classList.toggle('gm', p);
  if (window.Sky) { Sky.set(S.settings.animatedBg !== false); Sky.hold(p); }
  p ? fpsStop() : fpsStart();
  $('#gmChip').classList.toggle('hidden', !(S.gameActive && S.settings.gameMode !== false));
}
addEventListener('focus', syncPerf); addEventListener('blur', syncPerf);
nevix.onGameMode(d => { const was = S.gameActive; S.gameActive = !!d.active; syncPerf(); if (S.gameActive && !was) toast('Game Mode on: NEVIX is saving resources'); });

// animated sky: twinkling stars + shooting stars (canvas, ~30fps, paused when hidden or disabled)
var Sky = (() => {
  const c = $('#bg'), x = c.getContext('2d');
  let W = 0, H = 0, stars = [], shots = [], raf = 0, last = 0, nextShot = 0, on = false, held = false, rgb = '34,211,238';
  const rnd = (a, b) => a + Math.random() * (b - a);
  function size() {
    W = c.width = innerWidth; H = c.height = innerHeight;
    const n = Math.min(220, Math.round(W * H / 9000));
    stars = Array.from({ length: n }, () => { const d = Math.random(); return { x: Math.random() * W, y: Math.random() * H, r: 0.35 + d * 1.15, v: 0.2 + d * 0.8, a: 0.25 + d * 0.65, p: Math.random() * 6.28, s: rnd(0.6, 2.2) }; });
  }
  function accent() {
    const h = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    if (/^#[0-9a-f]{6}$/i.test(h)) rgb = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',');
  }
  function shoot() {
    accent();
    const ang = rnd(0.45, 0.85), sp = rnd(650, 950), len = rnd(110, 230);
    shots.push({ x: rnd(W * 0.25, W * 1.05), y: rnd(-30, H * 0.35), vx: -Math.cos(ang) * sp, vy: Math.sin(ang) * sp, len, life: 0, dur: rnd(0.9, 1.5) });
  }
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (t - last < 33) return;
    const dt = Math.min((t - last) / 1000, 0.1); last = t;
    x.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.y += s.v * dt * 6; s.x -= s.v * dt * 3;
      if (s.y > H + 2) { s.y = -2; s.x = Math.random() * W; } if (s.x < -2) s.x = W + 2;
      x.fillStyle = `rgba(205,240,255,${(s.a * (0.65 + 0.35 * Math.sin(t / 1000 * s.s + s.p))).toFixed(3)})`;
      if (s.r > 0.9) { x.beginPath(); x.arc(s.x, s.y, s.r, 0, 6.283); x.fill(); } else x.fillRect(s.x, s.y, 1.2, 1.2);
    }
    if (t > nextShot && shots.length < 2) { shoot(); nextShot = t + rnd(2500, 6500); }
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i]; s.life += dt; s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.life > s.dur || s.x < -300 || s.y > H + 300) { shots.splice(i, 1); continue; }
      const a = Math.min(1, s.life / 0.15) * Math.max(0, 1 - s.life / s.dur), n = Math.hypot(s.vx, s.vy);
      const tx = s.x - s.vx / n * s.len, ty = s.y - s.vy / n * s.len;
      const g = x.createLinearGradient(s.x, s.y, tx, ty);
      g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`); g.addColorStop(0.3, `rgba(${rgb},${(a * 0.55).toFixed(3)})`); g.addColorStop(1, `rgba(${rgb},0)`);
      x.strokeStyle = g; x.lineWidth = 1.8; x.lineCap = 'round'; x.beginPath(); x.moveTo(s.x, s.y); x.lineTo(tx, ty); x.stroke();
      x.fillStyle = `rgba(${rgb},${(a * 0.25).toFixed(3)})`; x.beginPath(); x.arc(s.x, s.y, 4, 0, 6.283); x.fill();
      x.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`; x.beginPath(); x.arc(s.x, s.y, 1.6, 0, 6.283); x.fill();
    }
  }
  function start() { if (on) return; on = true; size(); last = 0; nextShot = performance.now() + 1500; if (!document.hidden && !held) raf = requestAnimationFrame(frame); }
  function stop() { on = false; cancelAnimationFrame(raf); raf = 0; shots = []; x.clearRect(0, 0, W, H); }
  addEventListener('resize', () => { if (on) size(); });
  document.addEventListener('visibilitychange', () => { if (!on || held) return; if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else if (!raf) { last = 0; raf = requestAnimationFrame(frame); } });
  function hold(h) { held = !!h; if (!on) return; if (held) { cancelAnimationFrame(raf); raf = 0; } else if (!raf && !document.hidden) { last = 0; raf = requestAnimationFrame(frame); } }
  return { hold, held: () => held, set(v) { document.body.classList.toggle('still', !v); v ? start() : stop(); }, shoot, running: () => on };
})();

// splash: 5 seconds, animated, "Welcome, <name>"
const splashDone = new Promise(res => {
  const steps = [[0, 'Initializing...'], [1600, 'Loading library...'], [3200, 'Preparing interface...'], [4500, 'Ready']];
  steps.forEach(([t, m]) => setTimeout(() => { $('#spStatus').textContent = m; }, t));
  setTimeout(() => { $('#splash').classList.add('out'); setTimeout(() => { $('#splash').remove(); res(); }, 650); }, 5000);
});
function splashWelcome(name) {
  const txt = name ? 'Welcome, ' + name : 'Welcome', el = $('#spWelcome'); el.innerHTML = '';
  [...txt].forEach((ch, i) => { const sp = document.createElement('span'); sp.textContent = ch === ' ' ? '\u00a0' : ch; sp.style.animationDelay = (0.5 + i * 0.06) + 's'; el.appendChild(sp); });
}
splashWelcome('');
(async () => {
  try { const r = await nevix.getLibrary(); apply(r); if (r.corrupted) toast('Library file was damaged. A backup was kept and a new library started.', true); } catch (_) { toast('Could not load library', true); }
  splashWelcome((S.settings.userName || '').trim());
  render();
  await splashDone;
  if (!S.settings.firstScanDone) runScan(true);
})();
