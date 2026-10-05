// 打开服务器后台，切到「帮助图片」页截图（用 CDP，避开浏览器缓存）
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'admin-tab.png';
const PORT = 9444 + Math.floor(Math.random() * 100);

const chrome = spawn(CHROME, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--disable-cache',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + path.join(require('os').tmpdir(), 'alea-shot-' + Date.now()),
  '--window-size=1280,830',
  'http://<服务器IP>:8787/',
]);

function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let d = ''; r.on('data', c => (d += c)); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

(async () => {
  for (let i = 0; i < 50; i++) {
    try { await get('/json/version'); break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  const tabs = await get('/json/list');
  const page = tabs.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 1;
  const call = (method, params) => new Promise(res => {
    const myId = id++;
    const h = (d) => { const j = JSON.parse(d); if (j.id === myId) { ws.off('message', h); res(j.result); } };
    ws.on('message', h);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  await new Promise(r => ws.on('open', r));
  // 强制绕过缓存重新加载
  await call('Network.enable', {});
  await call('Network.setCacheDisabled', { cacheDisabled: true });
  await call('Page.enable', {});
  await call('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 3500));

  await call('Runtime.evaluate', {
    expression: `document.querySelector('nav button[data-tab="helpimg"]').click()`,
  });
  await new Promise(r => setTimeout(r, 2800));

  const shot = await call('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图完成:', OUT);
  chrome.kill();
  process.exit(0);
})().catch(e => { console.log('ERR', e.message); chrome.kill(); process.exit(1); });
