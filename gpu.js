// Real GPU stats. NVIDIA: nvidia-smi (usage, temperature, VRAM). Any other GPU on Windows: 3D-engine usage via WMI.
// Samples only while the UI keeps asking (stops ~8s after the last request), so it costs nothing when idle/paused.
const { execFile, spawn } = require('child_process');

const SMI_ARGS = ['--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'];
const sysRoot = process.env.SystemRoot || 'C:\\Windows', pf = process.env.ProgramFiles || 'C:\\Program Files';
const SMI_BINS = ['nvidia-smi', sysRoot + '\\System32\\nvidia-smi.exe', pf + '\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];

const PS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  'while($true){',
  '  $g=@{}',
  '  Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ForEach-Object {',
  "    if($_.Name -match 'luid_(0x[0-9A-Fa-f]+_0x[0-9A-Fa-f]+)_phys_\\d+_eng_(\\d+)_engtype_3D$'){ $k=$matches[1]+':'+$matches[2]; $g[$k]=[double]$g[$k]+[double]$_.UtilizationPercentage }",
  '  }',
  '  $m=0; foreach($v in $g.Values){ if($v -gt $m){ $m=$v } }',
  "  if($g.Count -gt 0){ [Console]::Out.WriteLine([math]::Min(100,[math]::Round($m))) } else { [Console]::Out.WriteLine('NA') }",
  '  [Console]::Out.Flush()',
  '  Start-Sleep -Seconds 3',
  '}'
].join('\n');

const num = v => { const n = parseFloat(v); return isNaN(n) ? null : Math.round(n); };
function parseNvidia(out) {
  let best = null;
  for (const line of String(out).split(/\r?\n/)) {
    const r = line.split(',').map(x => x.trim());
    if (r.length < 5) continue;
    const usage = num(r[1]);
    if (usage === null) continue;
    if (!best || usage > best.usage) best = { name: r[0], usage, temp: num(r[2]), vramUsedMB: num(r[3]), vramTotalMB: num(r[4]), source: 'nvidia' };
  }
  return best;
}
function parsePsLine(line) {
  const t = String(line).trim();
  return /^\d+(\.\d+)?$/.test(t) ? { name: null, usage: Math.min(100, Math.round(+t)), temp: null, vramUsedMB: null, vramTotalMB: null, source: 'wmi' } : null;
}

let sample = null, mode = null, timer = null, busy = false, lastReq = 0, ps = null, psStart = 0, psFails = 0, na = 0, bin = null;

function smi(b) {
  return new Promise(res => execFile(b, SMI_ARGS, { timeout: 4000, windowsHide: true }, (err, out) => res(err ? null : parseNvidia(out))));
}
async function nvSample() {
  if (bin) return smi(bin);
  for (const b of SMI_BINS) { const s = await smi(b); if (s) { bin = b; return s; } }
  return null;
}
function killPs() { if (ps) { try { ps.kill(); } catch (_) {} ps = null; } }
function startPs() {
  try {
    psStart = Date.now();
    ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    ps.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const s = parsePsLine(line);
        if (s) { sample = s; na = 0; } else if (line.trim() === 'NA' && ++na >= 3) { mode = 'none'; sample = null; killPs(); }
      }
    });
    ps.once('error', () => { ps = null; mode = 'none'; });
    ps.once('exit', () => { ps = null; if (Date.now() - psStart < 5000 && ++psFails >= 3) mode = 'none'; });
  } catch (_) { ps = null; mode = 'none'; }
}
async function loop() {
  timer = null; busy = true;
  try {
    if (Date.now() - lastReq > 8000) { killPs(); busy = false; return; } // nobody is watching
    if (mode === null) mode = (await nvSample()) ? 'nvidia' : (process.platform === 'win32' ? 'ps' : 'none');
    if (mode === 'nvidia') {
      const s = await nvSample();
      if (s) sample = s; else { sample = null; mode = process.platform === 'win32' ? 'ps' : 'none'; }
    }
    if (mode === 'ps' && !ps) startPs();
  } catch (_) {}
  busy = false;
  timer = setTimeout(loop, 3000);
}
function get() {
  lastReq = Date.now();
  if (!timer && !busy) timer = setTimeout(loop, 0);
  return mode === 'none' ? { unavailable: true } : sample;
}
function stop() { clearTimeout(timer); timer = null; killPs(); }
module.exports = { get, stop, parseNvidia, parsePsLine };
