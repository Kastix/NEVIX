const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SKIP_EXE = /(unins|uninst|setup|installer|redist|vc_?redist|dxsetup|dotnet|crash|report|helper|updater|diagnos|anticheat|battleye|beservice|eac_|cefsub|webhelper|notification|physx|prereq|cleanup|sendrpt|bugsplat|oalinst|handler|python|ffmpeg)/i;
const SKIP_DIR = /^(_commonredist|commonredist|redist|redistributables?|directx|dotnet|vcredist|__installer|easyanticheat|battleye|engine|mono|monobleedingedge|crashreportclient|crashpad)$/i;
const SKIP_NAME = /^(steam|steamlibrary|riot client|riot vanguard|common|redist|epic games|__installer|battleye|easyanticheat)$/i;
const SKIP_STEAM = /(steamworks|redistributable|steam linux runtime|proton)/i;

const exists = async p => { try { await fsp.access(p); return true; } catch { return false; } };
const clean = n => String(n).replace(/[_]+/g, ' ').trim();

async function collect(dir, depth, out, budget) {
  if (budget.n-- <= 0) return;
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isFile() && /\.exe$/i.test(e.name) && !SKIP_EXE.test(e.name)) {
      try { out.push({ p, size: (await fsp.stat(p)).size }); } catch {}
    } else if (e.isDirectory() && depth > 0 && !SKIP_DIR.test(e.name)) await collect(p, depth - 1, out, budget);
  }
}
async function pickExe(dir, preferred) {
  if (preferred) {
    const pp = path.isAbsolute(preferred) ? preferred : path.join(dir, preferred);
    if (/\.exe$/i.test(pp) && await exists(pp)) return pp;
  }
  for (const depth of [1, 4]) {
    const out = [];
    await collect(dir, depth, out, { n: 400 });
    if (out.length) return out.sort((a, b) => b.size - a.size)[0].p;
  }
  return null;
}
async function drives() {
  if (process.platform !== 'win32') return [];
  const list = [];
  await Promise.all('CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async d => {
    const ok = await Promise.race([exists(d + ':\\'), new Promise(r => setTimeout(() => r(false), 1500))]);
    if (ok) list.push(d);
  }));
  return list.sort();
}
const split = v => (v || '').split(';').map(s => s.trim()).filter(Boolean);

async function scanGames() {
  const found = new Map();
  const add = (name, p, extra = {}) => {
    if (!name || (!p && !extra.steamId)) return;
    const k = p ? p.toLowerCase() : 'steam:' + extra.steamId;
    if (!found.has(k)) found.set(k, { name: clean(name).slice(0, 60), path: p || null, ...(extra.steamId ? { steamId: extra.steamId } : {}) });
  };
  const env = process.env, drv = await drives();
  const pf = [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean);

  // Steam
  const steam = new Map();
  const addSteam = p => steam.set(p.toLowerCase(), p);
  split(env.NEVIX_STEAM_ROOTS).forEach(addSteam);
  pf.forEach(b => addSteam(path.join(b, 'Steam')));
  for (const d of drv) ['Steam', 'SteamLibrary', 'Games\\Steam', 'Games\\SteamLibrary', 'Program Files (x86)\\Steam'].forEach(s => addSteam(`${d}:\\${s}`));
  const libs = new Map();
  for (const sr of steam.values()) {
    if (!await exists(sr)) continue;
    libs.set(sr.toLowerCase(), sr);
    try {
      const vdf = await fsp.readFile(path.join(sr, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) { const l = m[1].replace(/\\\\/g, '\\'); libs.set(l.toLowerCase(), l); }
    } catch {}
  }
  for (const lib of libs.values()) {
    const apps = path.join(lib, 'steamapps');
    let files = []; try { files = await fsp.readdir(apps); } catch { continue; }
    for (const f of files.filter(x => /^appmanifest_\d+\.acf$/i.test(x))) {
      try {
        const t = await fsp.readFile(path.join(apps, f), 'utf8');
        const name = (t.match(/"name"\s+"([^"]*)"/) || [])[1], dir = (t.match(/"installdir"\s+"([^"]*)"/) || [])[1];
        if (!name || !dir || SKIP_STEAM.test(name)) continue;
        const gd = path.join(apps, 'common', dir);
        const id = (t.match(/"appid"\s+"(\d+)"/i) || [])[1] || (f.match(/\d+/) || [])[0];
        if (await exists(gd)) add(name, await pickExe(gd), { steamId: id });
      } catch {}
    }
  }

  // Epic Games
  try {
    const md = path.join(env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
    for (const f of (await fsp.readdir(md)).filter(x => x.endsWith('.item'))) {
      try {
        const j = JSON.parse(await fsp.readFile(path.join(md, f), 'utf8'));
        if (Array.isArray(j.AppCategories) && !j.AppCategories.includes('games')) continue;
        if (j.DisplayName && j.InstallLocation && await exists(j.InstallLocation)) add(j.DisplayName, await pickExe(j.InstallLocation, j.LaunchExecutable));
      } catch {}
    }
  } catch {}

  // Other launchers / common game folders (each sub-folder = one game)
  const roots = split(env.NEVIX_SCAN_ROOTS);
  for (const d of drv) ['Games', 'Game', 'Gry', 'GOG Games', 'XboxGames', 'Riot Games', 'Program Files\\Riot Games', 'Program Files (x86)\\GOG Galaxy\\Games', 'Program Files\\EA Games', 'Program Files (x86)\\EA Games', 'Program Files (x86)\\Origin Games', 'Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games'].forEach(s => roots.push(`${d}:\\${s}`));
  for (const r of roots) {
    let kids = []; try { kids = await fsp.readdir(r, { withFileTypes: true }); } catch { continue; }
    for (const k of kids.filter(x => x.isDirectory() && !SKIP_NAME.test(x.name))) {
      let gd = path.join(r, k.name);
      if (await exists(path.join(gd, 'Content'))) gd = path.join(gd, 'Content');
      add(k.name, await pickExe(gd));
    }
  }

  // Battle.net titles + well-known apps
  for (const b of pf) for (const n of ['Overwatch', 'World of Warcraft', 'Diablo III', 'Diablo IV', 'Hearthstone', 'StarCraft II']) {
    const gd = path.join(b, n); if (await exists(gd)) add(n, await pickExe(gd));
  }
  for (const b of pf) { const p = path.join(b, 'Minecraft Launcher', 'MinecraftLauncher.exe'); if (await exists(p)) add('Minecraft', p); }
  try {
    const vd = path.join(env.LOCALAPPDATA || '', 'Roblox', 'Versions');
    const vers = await fsp.readdir(vd, { withFileTypes: true }); let best = null;
    for (const v of vers.filter(x => x.isDirectory())) {
      const p = path.join(vd, v.name, 'RobloxPlayerBeta.exe');
      try { const m = (await fsp.stat(p)).mtimeMs; if (!best || m > best.m) best = { p, m }; } catch {}
    }
    if (best) add('Roblox', best.p);
  } catch {}

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 150);
}

const SKIP_SEARCH = /^(windows|\$recycle\.bin|system volume information|appdata|node_modules|programdata|\.git)$/i;
async function findExe(root, base, depth = 4) {
  const budget = { n: 1500 };
  async function walk(dir, d) {
    if (budget.n-- <= 0) return null;
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) if (e.isFile() && e.name.toLowerCase() === base) return path.join(dir, e.name);
    if (d <= 0) return null;
    for (const e of ents) if (e.isDirectory() && !SKIP_SEARCH.test(e.name)) { const r = await walk(path.join(dir, e.name), d - 1); if (r) return r; }
    return null;
  }
  return walk(root, depth);
}

// Steam game folder -> steam://rungameid/<appid> (launching the exe directly often fails without Steam)
async function steamUrlFor(exe) {
  const m = /^(.*?[\\/]steamapps)[\\/]common[\\/]([^\\/]+)[\\/]/i.exec(exe || '');
  if (!m) return null;
  try {
    for (const f of await fsp.readdir(m[1])) {
      if (!/^appmanifest_\d+\.acf$/i.test(f)) continue;
      const t = await fsp.readFile(path.join(m[1], f), 'utf8');
      const dir = (t.match(/"installdir"\s+"([^"]*)"/i) || [])[1];
      if (dir && dir.toLowerCase() === m[2].toLowerCase()) return 'steam://rungameid/' + ((t.match(/"appid"\s+"(\d+)"/i) || [])[1] || f.match(/\d+/)[0]);
    }
  } catch {}
  return null;
}
module.exports = { scanGames, findExe, steamUrlFor };
