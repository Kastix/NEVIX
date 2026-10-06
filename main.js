const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, protocol, net, shell } = require('electron');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { scanGames, findExe, steamUrlFor } = require('./scanner');
const gpu = require('./gpu');

app.setName('NEVIX');
protocol.registerSchemesAsPrivileged([{ scheme: 'nevix-icon', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win, tray, quitting = false;
const running = new Map(); // id -> pid
const DEFAULTS = { accent: '#22d3ee', startWithWindows: false, minimizeToTray: false, userName: '', firstScanDone: false, animatedBg: true, gameMode: true, gameModeMinimize: false };
let db = { games: [], settings: { ...DEFAULTS } };

const dbFile = () => path.join(app.getPath('userData'), 'library.json');

function loadDb() {
  try {
    let raw;
    try { raw = fs.readFileSync(dbFile(), 'utf8'); }
    catch (e) { // migrate library from the old NEXUS name
      if (e.code !== 'ENOENT') throw e;
      raw = fs.readFileSync(path.join(app.getPath('appData'), 'NEXUS', 'library.json'), 'utf8');
    }
    const p = JSON.parse(raw);
    db.games = Array.isArray(p.games) ? p.games.filter(g => g && g.id && (g.path || g.url)) : [];
    db.settings = { ...DEFAULTS, ...(p.settings || {}) };
  } catch (e) {
    if (e.code !== 'ENOENT') { // corrupted: keep a backup, start clean
      try { fs.copyFileSync(dbFile(), dbFile() + '.corrupt-' + Date.now()); } catch (_) {}
      db.corrupted = true;
    }
  }
}
function saveDb() {
  try {
    fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
    const tmp = dbFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ games: db.games, settings: db.settings }, null, 2));
    fs.renameSync(tmp, dbFile());
    return true;
  } catch (e) { return false; }
}
const view = () => ({ games: db.games.map(g => ({ ...g, running: running.has(g.id) })), settings: db.settings, corrupted: !!db.corrupted });
const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1000, minHeight: 640,
    frame: false, backgroundColor: '#05080d', show: false,
    icon: path.join(__dirname, 'assets/icons/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', e => e.preventDefault()); // dropped files must never navigate the window
  win.on('maximize', () => send('win:state', true));
  win.on('unmaximize', () => send('win:state', false));
  win.on('close', e => {
    if (!quitting && db.settings.minimizeToTray && tray) { e.preventDefault(); win.hide(); }
  });
}

function setupTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets/icons/icon.png'));
    tray = new Tray(img.resize({ width: 16, height: 16 }));
    tray.setToolTip('NEVIX');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open NEVIX', click: () => { win.show(); win.focus(); } },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => { win.show(); win.focus(); });
  } catch (_) { tray = null; }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    loadDb();
    protocol.handle('nevix-icon', req => {
      const id = new URL(req.url).hostname;
      const file = path.join(iconsDir(), id + '.png');
      if (!/^[a-z0-9]+$/.test(id) || !fs.existsSync(file)) return new Response('', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });
    createWindow(); setupTray();
    win.webContents.once('did-finish-load', async () => { // fetch icons for games that have none yet
      let changed = false;
      for (const g of db.games.filter(x => !x.steamChecked)) { await applySteam(g); changed = true; } // old entries inside steamapps -> launch via Steam
      const todo = db.games.filter(g => !g.hasIcon);
      if (todo.length) { await extractMany(todo); changed = true; }
      if (changed) { saveDb(); send('lib:changed', view()); }
    });
  });
  app.on('before-quit', () => { quitting = true; gpu.stop(); });
  app.on('window-all-closed', () => app.quit());
}

// ---- game model helpers ----
const URL_OK = /^(steam|com\.epicgames\.launcher|uplay|origin2|goggalaxy|battlenet):\/\/[^\s"<>]+$/i;
const splitArgs = t => (String(t || '').match(/"[^"]*"|\S+/g) || []).map(a => a.replace(/^"|"$/g, ''));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function makeGame(i) {
  const g = { id: newId(), name: String(i.name || 'Game').trim().slice(0, 60) || 'Game', favorite: false, launches: 0, lastLaunched: null, added: Date.now(), steamChecked: true };
  if (i.path) g.path = i.path;
  if (i.url) g.url = i.url;
  if (i.args && i.args.length) g.args = i.args;
  if (i.iconSource) g.iconSource = i.iconSource;
  return g;
}
const isDup = i => db.games.some(g => (i.path && g.path && g.path.toLowerCase() === i.path.toLowerCase()) || (i.url && g.url && g.url.toLowerCase() === i.url.toLowerCase()));
async function applySteam(g) {
  if (!g.url && g.path) { const u = await steamUrlFor(g.path); if (u) g.url = u; }
  g.steamChecked = true;
}

// ---- icons ----
const iconsDir = () => path.join(app.getPath('userData'), 'icons');
async function extractIcon(g) {
  try {
    for (const src of [g.iconSource, g.path].filter(p => p && fs.existsSync(p))) {
      let img = null;
      if (/\.(ico|png|jpe?g)$/i.test(src)) img = nativeImage.createFromPath(src);
      else {
        try { img = await Promise.race([nativeImage.createThumbnailFromPath(src, { width: 256, height: 256 }), new Promise((_, no) => setTimeout(no, 4000))]); } catch (_) {}
        if (!img || img.isEmpty()) { try { img = await app.getFileIcon(src, { size: 'large' }); } catch (_) {} }
      }
      if (!img || img.isEmpty()) continue;
      const { width, height } = img.getSize(), m = Math.max(width, height);
      if (m > 256) img = img.resize({ width: Math.round(width * 256 / m), height: Math.round(height * 256 / m), quality: 'best' });
      fs.mkdirSync(iconsDir(), { recursive: true });
      fs.writeFileSync(path.join(iconsDir(), g.id + '.png'), img.toPNG());
      g.hasIcon = Date.now();
      return true;
    }
  } catch (_) {}
  return false;
}
async function extractMany(list) {
  const q = [...list];
  await Promise.all([0, 1, 2, 3].map(async () => { while (q.length) await extractIcon(q.shift()); }));
}

// ---- launching + self-repair ----
function trySpawn(file, cwd, args = []) {
  return new Promise(resolve => {
    let settled = false;
    const done = r => { if (!settled) { settled = true; resolve(r); } };
    try {
      const child = spawn(file, args, { cwd, detached: true, stdio: 'ignore' });
      child.once('error', e => done({ ok: false, code: e.code || 'UNKNOWN' }));
      child.once('spawn', () => done({ ok: true, child }));
    } catch (e) { done({ ok: false, code: e.code || 'UNKNOWN' }); }
  });
}
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
async function findMoved(g) {
  const base = path.basename(g.path).toLowerCase();
  let dir = path.dirname(g.path); // nearest folder that still exists
  while (dir && !fs.existsSync(dir)) { const up = path.dirname(dir); if (up === dir) { dir = null; break; } dir = up; }
  if (dir && path.dirname(dir) !== dir) { const near = await findExe(dir, base); if (near) return near; }
  const all = await scanGames();
  const hit = all.find(f => path.basename(f.path).toLowerCase() === base) || all.find(f => norm(f.name) === norm(g.name));
  return hit ? hit.path : null;
}
async function repair(g, code) {
  if (code === 'ENOENT' || !fs.existsSync(g.path)) {
    const np = await findMoved(g);
    if (np) {
      g.path = np; await extractIcon(g); saveDb();
      const r = await trySpawn(np, path.dirname(np));
      if (r.ok) return { ok: true, child: r.child, note: `Found ${g.name} at its new location and started it.` };
    }
  }
  if (fs.existsSync(g.path)) { // ShellExecute handles admin prompts and app aliases
    const err = await shell.openPath(g.path);
    if (!err) return { ok: true, shell: true, note: 'Started through Windows (fixed automatically).' };
  }
  if (/minecraft/i.test(g.name)) { // Microsoft Store edition of the Minecraft Launcher
    const err = await shell.openPath('shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft');
    if (!err) return { ok: true, shell: true, note: 'Started the Microsoft Store Minecraft Launcher.' };
  }
  return { ok: false };
}

// ---- Game Mode: while a game runs, lower NEVIX priority and let the UI pause animations ----
const gmWatch = new Map(); // id -> { exe, tracked, seen, since }
const GM_POLL_MS = Number(process.env.NEVIX_GM_POLL_MS) || 8000; // (env override is only for testing)
let gmTimer = null;
function setPrio(low) {
  const v = low ? os.constants.priority.PRIORITY_BELOW_NORMAL : os.constants.priority.PRIORITY_NORMAL;
  let pids = [process.pid]; try { pids = [process.pid, ...app.getAppMetrics().map(m => m.pid)]; } catch (_) {}
  for (const pid of new Set(pids)) { try { os.setPriority(pid, v); } catch (_) {} }
}
function gmNotify() { send('gamemode', { active: gmWatch.size > 0 && db.settings.gameMode !== false }); }
function gmStart(g, tracked) {
  if (db.settings.gameMode === false) return;
  const first = gmWatch.size === 0;
  gmWatch.set(g.id, { exe: g.path ? path.basename(g.path).toLowerCase() : null, tracked, seen: tracked, since: Date.now() });
  if (first) setPrio(true);
  if (db.settings.gameModeMinimize && win && !win.isDestroyed()) win.minimize();
  gmNotify();
  if (!gmTimer) gmTimer = setInterval(gmPoll, GM_POLL_MS);
}
function gmEnd(id) {
  if (!gmWatch.delete(id)) return;
  if (!gmWatch.size) { setPrio(false); clearInterval(gmTimer); gmTimer = null; }
  gmNotify();
}
function listProcs() {
  const win32 = process.platform === 'win32';
  return new Promise(res => execFile(win32 ? 'tasklist' : 'ps', win32 ? ['/FO', 'CSV', '/NH'] : ['-A', '-o', 'comm='], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
    if (err) return res(null);
    const set = new Set();
    for (const line of out.split(/\r?\n/)) { const n = win32 ? (/^"([^"]+)"/.exec(line) || [])[1] : path.basename(line.trim()); if (n) set.add(n.toLowerCase()); }
    res(set);
  }));
}
async function gmPoll() { // games started through Steam etc. can't be tracked directly: watch for their process by name
  const watch = [...gmWatch].filter(([, w]) => !w.tracked);
  if (!watch.length) return;
  const procs = await listProcs(); if (!procs) return;
  for (const [id, w] of watch) {
    if (w.exe && procs.has(w.exe)) w.seen = true;
    else if (w.seen || !w.exe || Date.now() - w.since > 120000) gmEnd(id); // closed, or never detected: stop assuming it runs
  }
}

// ---- IPC ----
ipcMain.handle('lib:get', () => view());

ipcMain.handle('game:pick', async () => {
  try {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select game executable', properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: ['exe'] }]
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const p = r.filePaths[0];
    if (path.extname(p).toLowerCase() !== '.exe') return { error: 'Please choose a .exe file.' };
    const base = path.basename(p, '.exe').replace(/[_\-.]+/g, ' ').trim();
    return { path: p, name: base.replace(/\b\w/g, c => c.toUpperCase()) };
  } catch (e) { return { error: 'Could not open the file picker.' }; }
});

ipcMain.handle('game:add', async (_, { path: p, name }) => {
  try {
    if (typeof p !== 'string' || path.extname(p).toLowerCase() !== '.exe') return { error: 'Invalid executable path.' };
    if (!fs.existsSync(p)) return { error: 'Game executable not found.' };
    const info = { path: p, name: String(name || '').trim() || path.basename(p, '.exe'), url: await steamUrlFor(p) || undefined };
    if (isDup(info)) return { error: 'This game is already in your library.' };
    const ng = makeGame(info);
    db.games.push(ng); await extractIcon(ng);
    if (!saveDb()) return { error: 'Could not save the library (permission problem?).' };
    return { ok: true, ...view() };
  } catch (e) { return { error: 'Could not add the game.' }; }
});

ipcMain.handle('game:launch', async (_, id) => {
  const g = db.games.find(x => x.id === id);
  if (!g) return { error: 'Game not found in library.' };
  if (running.has(id)) return { error: 'Already running.' };
  if (g.url && URL_OK.test(g.url)) { // Steam & co: start through the launcher, exactly like a desktop shortcut
    try {
      await shell.openExternal(g.url);
      g.launches = (g.launches || 0) + 1; g.lastLaunched = Date.now(); saveDb();
      gmStart(g, false);
      return { ok: true, shell: true, note: /^steam:/i.test(g.url) ? 'Starting through Steam...' : null, ...view() };
    } catch (_) { /* fall back to the exe below */ }
  }
  if (!g.path) return { error: 'Could not start the game.', needsLocate: true };
  let r = fs.existsSync(g.path) ? await trySpawn(g.path, path.dirname(g.path), g.args) : { ok: false, code: 'ENOENT' };
  let note = null, viaShell = false;
  if (!r.ok) {
    send('game:status', { id, text: 'Fixing...' });
    let fix = { ok: false };
    try { fix = await repair(g, r.code); } catch (_) {}
    if (!fix.ok) {
      const error = r.code === 'ENOENT' ? 'Game executable not found.' : (r.code === 'EACCES' || r.code === 'EPERM') ? 'Permission denied.' : 'Could not start the game.';
      return { error, needsLocate: true };
    }
    r = fix; note = fix.note; viaShell = !!fix.shell;
  }
  if (r.child) {
    running.set(id, r.child.pid);
    r.child.once('exit', () => { running.delete(id); send('game:exit', id); gmEnd(id); });
    r.child.unref();
  }
  g.launches = (g.launches || 0) + 1; g.lastLaunched = Date.now(); saveDb();
  gmStart(g, !!r.child);
  return { ok: true, note, shell: viaShell, ...view() };
});

ipcMain.handle('game:relocate', async (_, id) => {
  const g = db.games.find(x => x.id === id);
  if (!g) return { error: 'Game not found.' };
  const r = await dialog.showOpenDialog(win, { title: 'Locate game executable', properties: ['openFile'], filters: [{ name: 'Executable', extensions: ['exe'] }] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  g.path = r.filePaths[0];
  if (/^steam:/i.test(g.url || '')) delete g.url;
  await applySteam(g);
  if (!g.customIcon) await extractIcon(g);
  saveDb();
  return { ok: true, ...view() };
});

ipcMain.handle('scan:run', async () => {
  try {
    const have = new Set(db.games.flatMap(g => [g.path, g.url]).filter(Boolean).map(x => x.toLowerCase()));
    return { found: (await scanGames()).filter(f => !(f.path && have.has(f.path.toLowerCase())) && !(f.steamId && have.has('steam://rungameid/' + f.steamId))) };
  } catch (e) { return { error: 'Scan failed. You can still add games manually.' }; }
});

ipcMain.handle('game:addMany', async (_, items) => {
  try {
    let n = 0; const fresh = [];
    for (const it of Array.isArray(items) ? items : []) {
      if (!it) continue;
      const p = typeof it.path === 'string' && path.extname(it.path).toLowerCase() === '.exe' && fs.existsSync(it.path) ? it.path : null;
      let url = /^\d+$/.test(String(it.steamId || '')) ? 'steam://rungameid/' + it.steamId : null;
      if (!p && !url) continue;
      if (!url && p) url = await steamUrlFor(p);
      const info = { name: String(it.name || (p ? path.basename(p, '.exe') : 'Game')), path: p, url: url || undefined };
      if (isDup(info)) continue;
      const ng = makeGame(info); db.games.push(ng); fresh.push(ng); n++;
    }
    await extractMany(fresh);
    if (n && !saveDb()) return { error: 'Could not save the library (permission problem?).' };
    return { ok: true, added: n, ...view() };
  } catch (e) { return { error: 'Could not add games.' }; }
});

// ---- Quick Drop: shortcuts (.url / .lnk) or .exe dropped anywhere in the window ----
async function resolveDropped(p) {
  const ext = path.extname(p).toLowerCase(), name = path.basename(p, path.extname(p)).replace(/[_]+/g, ' ').trim();
  try {
    if (ext === '.exe') return fs.existsSync(p) ? { name, path: p } : { error: 'File not found.' };
    if (ext === '.url') {
      const o = {};
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) { const m = /^\s*(URL|IconFile)\s*=\s*(.*?)\s*$/i.exec(line); if (m && !(m[1].toLowerCase() in o)) o[m[1].toLowerCase()] = m[2]; }
      if (!o.url || !URL_OK.test(o.url)) return { error: 'This shortcut is not a game launcher link.' };
      return { name, url: o.url, iconSource: o.iconfile && fs.existsSync(o.iconfile) ? o.iconfile : undefined };
    }
    if (ext === '.lnk') {
      let info; try { info = shell.readShortcutLink(p); } catch (_) { return { error: 'Could not read this shortcut.' }; }
      const target = info.target || '', args = info.args || '', sm = /-applaunch\s+(\d+)/i.exec(args);
      const iconSource = info.icon && /\.(ico|exe)$/i.test(info.icon) && fs.existsSync(info.icon) ? info.icon : undefined;
      if (/steam\.exe$/i.test(target) && sm) return { name, url: 'steam://rungameid/' + sm[1], iconSource };
      if (/\.exe$/i.test(target) && fs.existsSync(target)) return { name, path: target, args: splitArgs(args), iconSource };
      return { error: 'Shortcut target not found.' };
    }
  } catch (_) { return { error: 'Could not read this file.' }; }
  return { error: 'Unsupported file. Drop a game shortcut or an .exe.' };
}
ipcMain.handle('drop:add', async (_, paths) => {
  const res = { added: 0, skipped: 0, errors: [] }, fresh = [];
  try {
    for (const p of (Array.isArray(paths) ? paths.slice(0, 50) : [])) {
      if (typeof p !== 'string' || !p) continue;
      const info = await resolveDropped(p);
      if (info.error) { res.errors.push(`${path.basename(p)}: ${info.error}`); continue; }
      if (!info.url && info.path) info.url = await steamUrlFor(info.path) || undefined;
      if (isDup(info)) { res.skipped++; continue; }
      const g = makeGame(info); db.games.push(g); fresh.push(g); res.added++;
    }
    await extractMany(fresh);
    if (res.added && !saveDb()) res.errors.push('Could not save the library.');
  } catch (_) { res.errors.push('Something went wrong while adding.'); }
  return { ...res, ...view() };
});

ipcMain.handle('game:setIcon', async (_, id) => {
  try {
    const g = db.games.find(x => x.id === id);
    if (!g) return { error: 'Game not found.' };
    const r = await dialog.showOpenDialog(win, { title: 'Choose an icon image', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'ico'] }] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    let img = nativeImage.createFromPath(r.filePaths[0]);
    if (img.isEmpty()) return { error: 'Could not read that image. Try a PNG, JPG or ICO file.' };
    const { width, height } = img.getSize(), m = Math.max(width, height);
    if (m > 256) img = img.resize({ width: Math.round(width * 256 / m), height: Math.round(height * 256 / m), quality: 'best' });
    fs.mkdirSync(iconsDir(), { recursive: true });
    fs.writeFileSync(path.join(iconsDir(), g.id + '.png'), img.toPNG());
    g.hasIcon = Date.now(); g.customIcon = true;
    if (!saveDb()) return { error: 'Could not save the icon.' };
    return { ok: true, ...view() };
  } catch (e) { return { error: 'Could not set the icon.' }; }
});

ipcMain.handle('game:fav', (_, id) => { const g = db.games.find(x => x.id === id); if (g) { g.favorite = !g.favorite; saveDb(); } return view(); });
ipcMain.handle('game:remove', (_, id) => { try { fs.unlinkSync(path.join(iconsDir(), id + '.png')); } catch (_) {} db.games = db.games.filter(x => x.id !== id); saveDb(); return view(); });
ipcMain.handle('game:rename', (_, { id, name }) => { const g = db.games.find(x => x.id === id); const n = String(name || '').trim().slice(0, 60); if (g && n) { g.name = n; saveDb(); } return view(); });

ipcMain.handle('settings:set', (_, patch) => {
  const allowed = ['accent', 'startWithWindows', 'minimizeToTray', 'userName', 'firstScanDone', 'animatedBg', 'gameMode', 'gameModeMinimize'];
  for (const k of allowed) if (k in patch) db.settings[k] = patch[k];
  db.settings.userName = String(db.settings.userName || '').trim().slice(0, 24);
  db.settings.startWithWindows = !!db.settings.startWithWindows;
  db.settings.minimizeToTray = !!db.settings.minimizeToTray;
  db.settings.firstScanDone = !!db.settings.firstScanDone;
  db.settings.animatedBg = db.settings.animatedBg !== false;
  db.settings.gameMode = db.settings.gameMode !== false;
  db.settings.gameModeMinimize = !!db.settings.gameModeMinimize;
  if ('gameMode' in patch) { setPrio(db.settings.gameMode && gmWatch.size > 0); gmNotify(); }
  if (!/^#[0-9a-fA-F]{6}$/.test(db.settings.accent)) db.settings.accent = DEFAULTS.accent;
  if ('startWithWindows' in patch) { try { app.setLoginItemSettings({ openAtLogin: !!patch.startWithWindows }); } catch (_) {} }
  saveDb();
  return view();
});

let prev = os.cpus();
ipcMain.handle('sys:stats', () => {
  const cur = os.cpus(); let idle = 0, total = 0;
  cur.forEach((c, i) => {
    const p = prev[i] ? prev[i].times : c.times;
    for (const k in c.times) total += c.times[k] - (p[k] || 0);
    idle += c.times.idle - (p.idle || 0);
  });
  prev = cur;
  const tm = os.totalmem(), fm = os.freemem();
  return { cpu: total > 0 ? Math.round(100 * (1 - idle / total)) : 0, ram: Math.round(100 * (tm - fm) / tm), ramUsedGB: ((tm - fm) / 2 ** 30).toFixed(1), ramTotalGB: (tm / 2 ** 30).toFixed(1), gpu: gpu.get() };
});

ipcMain.on('win:min', () => win && win.minimize());
ipcMain.on('win:max', () => win && (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win && win.close());
