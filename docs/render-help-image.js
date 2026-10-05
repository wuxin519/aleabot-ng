#!/usr/bin/env node
/**
 * 指令图一键渲染脚本
 *
 * 解决的问题：`.page` 高度是内容自适应的，用固定 --window-size 截图会在底部
 * 留一大片空白（内容多高就多高，但 Chrome 只认窗口尺寸）。
 *
 * 做法：
 *   1. 先用超高窗口渲染，通过 CDP 读页面标题里写入的真实内容高度
 *   2. 再用「内容高度 × 缩放比」精确截图 → 底部零空白
 *
 * 用法：
 *   node render-help-image.js            # 2x（默认，成品用）
 *   node render-help-image.js 1          # 1x（快速预览）
 *
 * 产出：docs/指令图.png、public/help.png，并复制到桌面
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCALE = process.argv[2] || '2';
const DOCS = __dirname;
const ROOT = path.join(__dirname, '..');
const HTML = path.join(DOCS, '指令图.html');
const OUT = path.join(DOCS, '指令图.png');
const PORT = 9334;
const PROBE_HEIGHT = 1600; // 探测用的超高窗口，保证内容不被截

const fileUrl = 'file:///' + HTML.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('C%3A', 'C:');
const chromeArgs = (h, out) => [
  '--headless', '--disable-gpu', '--hide-scrollbars',
  `--force-device-scale-factor=${SCALE}`,
  `--window-size=1080,${h}`,
  ...(out ? [`--screenshot=${out}`] : []),
  ...(out ? [] : ['--remote-debugging-port=' + PORT]),
  '--user-data-dir=' + path.join(os.tmpdir(), 'alea-render-' + Date.now()),
  fileUrl,
];

function httpGet(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = ''; r.on('data', c => (d += c)); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

/** 探测页面真实内容高度（页面脚本会把高度写进 document.title） */
async function measure() {
  const chrome = spawn(CHROME, chromeArgs(PROBE_HEIGHT, null));
  try {
    for (let i = 0; i < 60; i++) {
      try { await httpGet('/json/version'); break; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    // 等 load + rAF 把 title 写好
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 200));
      const tabs = await httpGet('/json/list');
      const page = tabs.find(t => t.type === 'page');
      const m = page && /^H:(\d+)$/.exec(page.title || '');
      if (m) return parseInt(m[1], 10);
    }
    throw new Error('未能从页面标题读到内容高度（检查 HTML 里的测量脚本是否还在）');
  } finally {
    chrome.kill();
  }
}

/** 按精确高度截图 */
function shoot(height, out) {
  return new Promise((res, rej) => {
    const chrome = spawn(CHROME, chromeArgs(height, out));
    let settled = false;
    chrome.on('exit', () => {
      if (settled) return;
      settled = true;
      setTimeout(() => (fs.existsSync(out) ? res() : rej(new Error('截图文件未生成: ' + out))), 300);
    });
    setTimeout(() => {
      if (!settled) { settled = true; chrome.kill(); fs.existsSync(out) ? res() : rej(new Error('截图超时')); }
    }, 40000);
  });
}

(async () => {
  console.log('[1/3] 探测内容高度…');
  const h = await measure();
  console.log(`      内容高度 = ${h}px（${SCALE}x 输出 ${1080 * SCALE}×${h * SCALE}）`);

  console.log('[2/3] 精确渲染（底部不留空白）…');
  const tmp = path.join(os.tmpdir(), `alea-help-${SCALE}x.png`);
  await shoot(h, tmp);

  console.log('[3/3] 分发产出…');
  fs.copyFileSync(tmp, OUT);
  const pub = path.join(ROOT, 'public', 'help.png');
  if (fs.existsSync(path.dirname(pub))) fs.copyFileSync(tmp, pub);
  const desk = '骰娘指令一览.png';
  if (fs.existsSync(path.dirname(desk))) fs.copyFileSync(tmp, desk);

  for (const p of [OUT, pub, desk]) {
    if (fs.existsSync(p)) console.log(`      ✅ ${p}  (${fs.statSync(p).size} bytes)`);
  }
  console.log('\n完成。');
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
