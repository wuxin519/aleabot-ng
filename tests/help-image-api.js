/**
 * 后台「帮助图片」接口端到端测试
 *
 * 覆盖：
 *   1. GET  /api/help-image      读取当前图片信息（尺寸解析是否正确）
 *   2. POST /api/help-image      上传新图（含各种非法输入的拒绝）
 *   3. POST /api/help-image/reset 恢复默认图
 *   4. 引擎侧 .help 是否读到被替换后的图（验证「换图立即生效」）
 *
 * 运行：node tests/help-image-api.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PUBLIC_DIR = path.join(ROOT, 'public');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

/** 生成一个纯色 PNG（用于测试上传，不依赖任何图形库） */
function makePng(width, height, rgb = [255, 0, 0]) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 3);
    raw[off] = 0; // filter none
    for (let x = 0; x < width; x++) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 简易 HTTP 请求（避免引 express 依赖） */
function req(port, method, urlPath, body) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (resp) => {
      let d = '';
      resp.on('data', c => (d += c));
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* 非 JSON */ }
        res({ status: resp.statusCode, json, text: d });
      });
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  // 备份原图，测试后还原（避免污染项目）
  const helpPath = path.join(PUBLIC_DIR, 'help.png');
  const helpDir = path.join(PUBLIC_DIR, 'images');
  const origPath = path.join(helpDir, 'help.default.png');
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alea-api-bak-'));
  const hadHelp = fs.existsSync(helpPath);
  const hadOrig = fs.existsSync(origPath);
  if (hadHelp) fs.copyFileSync(helpPath, path.join(backupDir, 'help.png'));
  if (hadOrig) fs.copyFileSync(origPath, path.join(backupDir, 'help.default.png'));

  try {
    // 启动服务器（独立端口 + 独立 db）
    const { Store } = require(path.join(DIST, 'core', 'store.js'));
    const { Engine } = require(path.join(DIST, 'core', 'engine.js'));
    const { AdapterManager } = require(path.join(DIST, 'platforms', 'manager.js'));
    const { createWebServer } = require(path.join(DIST, 'web', 'server.js'));

    const dbPath = path.join(os.tmpdir(), `alea-api-test-${Date.now()}.db`);
    const store = new Store(dbPath);
    const engine = new Engine(store, { admins: [], backupDir: path.join(os.tmpdir(), 'alea-bak2') });
    const manager = new AdapterManager(engine);
    const PORT = 18787;
    const app = createWebServer({
      store, manager, backupDir: path.join(os.tmpdir(), 'alea-bak2'), port: PORT, adminToken: '',
    });
    const server = app.listen(PORT);
    await new Promise((r) => setTimeout(r, 400));

    console.log('--- 1. 读取当前图片 ---');
    const info1 = await req(PORT, 'GET', '/api/help-image');
    check('GET 返回 200', info1.status === 200);
    check('识别到图片存在', info1.json && info1.json.exists === true,
      info1.json ? `${info1.json.width}x${info1.json.height} ${info1.json.size}B` : '');
    // 基准尺寸：不写死数值，否则每次重排指令图都会误报失败
    const baseW = info1.json && info1.json.width;
    const baseH = info1.json && info1.json.height;
    check('尺寸解析为正数（PNG 头解析正常）',
      baseW > 0 && baseH > 0,
      info1.json ? `${baseW}x${baseH}` : '');
    check('首次访问会自动留档默认图', info1.json && info1.json.hasDefault === true);
    check('初始状态标记为默认图', info1.json && info1.json.isDefault === true);

    console.log('\n--- 2. 上传新图 ---');
    const png = makePng(300, 120, [0, 128, 255]);
    const dataUrl = 'data:image/png;base64,' + png.toString('base64');
    const up = await req(PORT, 'POST', '/api/help-image', { dataUrl });
    check('上传返回 200', up.status === 200, up.json ? JSON.stringify(up.json).slice(0, 80) : up.text.slice(0, 80));
    check('上传后尺寸变为 300x120', up.json && up.json.width === 300 && up.json.height === 120,
      up.json ? `${up.json.width}x${up.json.height}` : '');
    check('上传后不再是默认图', up.json && up.json.isDefault === false);
    check('磁盘文件确实被替换', fs.readFileSync(helpPath).length === png.length,
      `${fs.readFileSync(helpPath).length} vs ${png.length}`);

    console.log('\n--- 3. 换图后 .help 立即生效 ---');
    const engMsg = { platform: 'qq', groupId: '1', userId: '1', userName: 't', text: '.help', isPrivate: false };
    const r = await engine.handle(engMsg);
    check('.help 返回新图路径', !!(r && r.images && r.images.length === 1), r && r.images ? r.images[0] : '');
    check('.help 指向 public/help.png', !!(r && r.images && r.images[0].endsWith(path.join('public', 'help.png'))));
    const onDisk = fs.statSync(r.images[0]).size;
    check('.help 读到的就是刚上传的文件', onDisk === png.length, `${onDisk} bytes`);

    console.log('\n--- 4. 非法输入被拒绝 ---');
    const bad1 = await req(PORT, 'POST', '/api/help-image', {});
    check('缺 dataUrl → 400', bad1.status === 400, bad1.json ? bad1.json.error : '');
    const bad2 = await req(PORT, 'POST', '/api/help-image', { dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' });
    check('非 PNG 格式 → 400', bad2.status === 400, bad2.json ? bad2.json.error : '');
    const bad3 = await req(PORT, 'POST', '/api/help-image', {
      dataUrl: 'data:image/png;base64,' + Buffer.from('not a png at all').toString('base64'),
    });
    check('伪造 PNG → 400', bad3.status === 400, bad3.json ? bad3.json.error : '');

    console.log('\n--- 5. 恢复默认图 ---');
    const rst = await req(PORT, 'POST', '/api/help-image/reset', {});
    check('恢复返回 200', rst.status === 200, rst.json ? JSON.stringify(rst.json).slice(0, 80) : '');
    check(`恢复后尺寸回到原值（${baseW}x${baseH}）`,
      rst.json && rst.json.width === baseW && rst.json.height === baseH,
      rst.json ? `${rst.json.width}x${rst.json.height}` : '');
    check('恢复后标记为默认图', rst.json && rst.json.isDefault === true);

    server.close();
    store.close();
    try { fs.unlinkSync(dbPath); } catch { /* 忽略 */ }
  } finally {
    // 还原现场
    if (hadHelp) fs.copyFileSync(path.join(backupDir, 'help.png'), helpPath);
    if (hadOrig) fs.copyFileSync(path.join(backupDir, 'help.default.png'), origPath);
    else if (!hadOrig && fs.existsSync(origPath)) fs.unlinkSync(origPath);
    fs.rmSync(backupDir, { recursive: true, force: true });
  }

  console.log('\n========================================');
  console.log(`帮助图片接口测试: ${pass}/${pass + fail} 通过`);
  console.log(fail === 0 ? '✅ 全部通过' : '❌ 存在失败项');
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
