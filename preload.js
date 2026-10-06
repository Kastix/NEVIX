const { contextBridge, ipcRenderer, webUtils } = require('electron');
const inv = (c, a) => ipcRenderer.invoke(c, a);
contextBridge.exposeInMainWorld('nevix', {
  getLibrary: () => inv('lib:get'),
  pickExe: () => inv('game:pick'),
  addGame: d => inv('game:add', d),
  scan: () => inv('scan:run'),
  addMany: items => inv('game:addMany', items),
  launch: id => inv('game:launch', id),
  relocate: id => inv('game:relocate', id),
  toggleFav: id => inv('game:fav', id),
  getDropPath: f => { try { return webUtils.getPathForFile(f); } catch (_) { return ''; } },
  dropAdd: p => inv('drop:add', p),
  setIcon: id => inv('game:setIcon', id),
  remove: id => inv('game:remove', id),
  rename: (id, name) => inv('game:rename', { id, name }),
  setSettings: p => inv('settings:set', p),
  stats: () => inv('sys:stats'),
  win: { min: () => ipcRenderer.send('win:min'), max: () => ipcRenderer.send('win:max'), close: () => ipcRenderer.send('win:close'), onState: f => ipcRenderer.on('win:state', (_, s) => f(s)) },
  onStatus: f => ipcRenderer.on('game:status', (_, d) => f(d)),
  onLibChanged: f => ipcRenderer.on('lib:changed', (_, d) => f(d)),
  onGameMode: f => ipcRenderer.on('gamemode', (_, d) => f(d)),
  onGameExit: f => ipcRenderer.on('game:exit', (_, id) => f(id))
});
