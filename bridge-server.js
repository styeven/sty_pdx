// ============================================================
// 【整体介绍】
// 智能配电箱 MQTT 桥接服务
// 订阅厂商 MQTT 服务器上的真实数据，解析换算后通过 WebSocket 推送给浏览器看板。
// 用途：浏览器无法直连厂商原生 MQTT（44933 端口不支持 WebSocket），
//       本服务作为本地桥接层，实现「看板 → WebSocket ← 桥接服务 ← MQTT ← 设备」链路。
//
// 【依赖组件】
// - mqtt   : 订阅厂商服务器 /wlw_szxn_pdx/#
// - ws     : WebSocket 服务，推送给前端看板
// - node: 22+  (无其他依赖)
//
// 【使用】
//   node bridge-server.js [端口]     默认端口 3010
//   前端连接: ws://localhost:3010
//   快照查询: GET http://localhost:3010/api/state
//   历史数据: GET http://localhost:3010/api/history?hours=2&group=1
//   落盘文件: data-history.jsonl（相对当前目录，自动创建）
// ============================================================
const mqtt = require('mqtt');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- 配置区 ----------
// 【2026-09-01 修改】MQTT 服务器/账号/密码从 config.local.json 读取（该文件被 .gitignore 忽略，不入 git 仓库）
//   原因：项目准备公开提交 GitHub，厂商服务器地址与账号密码属客户敏感信息，严禁进 git 历史
//   使用：本机真实配置写 config.local.json（已创建，含真实凭据）；模板见 config.example.json（可入库）
//        读取失败时回退到内置默认值（仅本地演示用，不含任何真实凭据）
const CONFIG_FILE = path.join(__dirname, 'config.local.json');
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch (e) { console.warn(`[${ts()}] ⚠️ 未找到 ${path.basename(CONFIG_FILE)}，使用内置默认配置（仅本地演示）`); }

const PORT = parseInt(process.argv[2] || config.port || '3010', 10);
const BROKER = config.broker || 'mqtt://127.0.0.1:1883';   // 默认本地演示 broker，不内置客户服务器地址
const USER = config.user || '';
const PASS = config.pass || '';
const TOPIC = config.topic || '/wlw_szxn_pdx/#';
const IMEI_FILTER = config.imeiFilter || null; // 可设某网关 IMEI 只看该网关，null 表示全部

// 电能表 485 地址 → 回路编号（1号表=回路1 ... 3号表=回路3）
const METER_ADDR_TO_GROUP = { 1: 1, 2: 2, 3: 3 };
// 断路器 485 地址 → 回路编号（11号断路器=回路1 ... 13号断路器=回路3）
const DLQ_ADDR_TO_GROUP = { 11: 1, 12: 2, 13: 3 };
const GROUPS = [1, 2, 3];

// ---------- 异常帧过滤 ----------
// 【2026-08-31 新增】电压/电流换算后超过 1000（V/A）视为异常数据，整帧忽略不更新。
//   原因：坏帧/传感器异常会产生离谱数值，直接上屏会误导运维；保留最后正常值更安全。
//   注：按"换算后物理量"判断（电压÷100、电流÷100），非原始寄存器值，
//       否则正常电压(原始~22000)会被全部误判。
const ABNORMAL_VA_LIMIT = 1000; // V
const ABNORMAL_IA_LIMIT = 1000; // A

// ---------- 远程控制配置 ----------
// 【2026-08-31 新增】远程合闸/分闸（协议 V1_260723 控制章节）
//   控制主题: /wlw_szxn_pdx/{网关IMEI}/server_ctrl
//   合闸报文: {MsgType:'set_dlq_IO_on',  GWID:网关IMEI, MeterAdr:断路器485地址}
//   分闸报文: {MsgType:'set_dlq_IO_off', GWID:网关IMEI, MeterAdr:断路器485地址}
//   MeterAdr 为断路器 485 地址（11/12/13），与上报报文 rs485_addr 一致
const GROUP_TO_DLQ_ADDR = { 1: 11, 2: 12, 3: 13 }; // 回路 → 断路器485地址
const CONTROL_ENABLED = true;  // 控制总开关；现场调试/演练时置 false 可整体禁用

// ---------- 字段换算（原始寄存器值 → 物理量） ----------
// 【2026-08-31 换算规则说明】
//   实测报文: emt_VA=22740 → 227.40V（÷100，文档写0.1精度与实测不符）
//             emt_HZ=4999  → 49.99Hz（÷100 ✓）
//             emt_TPF=65   → 0.65（÷100，文档写0.001精度与实测不符）
//             emt_kW=290   → 0.29kW（÷1000 ✓ 文档0.001）
//             emt_kWh=181  → 1.81kWh（÷100 ✓ 文档0.01）
//             emt_IA=2     → 0.02A（÷100，用户确认电流精度 0.01A）
//   原因：与协议文档精度表存在出入（VA/TPF），以实测物理合理性为准，
//         建议后续向厂商确认最终精度定义。
const SCALE = {
  emt_VA: 100, emt_IA: 100, emt_kW: 1000, emt_kVar: 1000,
  emt_TPF: 100, emt_HZ: 100, emt_kWh: 100, emt_FWD_kWh: 100, emt_REV_kWh: 100,
};
function scaleMeter(raw) {
  const out = { raw };
  for (const [k, s] of Object.entries(SCALE)) {
    if (typeof raw[k] === 'number') out[k] = +(raw[k] / s).toFixed(4);
  }
  return out;
}

// ---------- 数据状态 ----------
const state = {
  brokerConnected: false,
  lastPacketTime: null,
  packetCount: 0,
  imei: null,
  groups: {},   // {1:{meter:{...换算后}, dlq:{dlq_IO,raw}, updatedAt}}
  events: [],   // 最近事件（环形）
};
for (const g of GROUPS) {
  state.groups[g] = {
    meter: null, dlq: null, meterRaw: null, dlqRaw: null, updatedAt: null,
  };
}
function pushEvent(text, type = 'info') {
  state.events.unshift({ time: new Date().toISOString(), text, type });
  if (state.events.length > 50) state.events.pop();
}

// ---------- 历史数据归档 ----------
// 【2026-08-31 新增】内存环形缓冲 + JSONL 落盘 + /api/history
//   容量：最近 5000 条（≈ 4.6h × 3 组，足够支撑日报/趋势分析）
//   落盘：每 30s 追加一次新数据到 data-history.jsonl（append 模式，进程重启不丢历史）
//   启动：从 data-history.jsonl 读最近 24h 入内存
const HISTORY_MAX = 5000;           // 内存最大条数
const HISTORY_FLUSH_MS = 30000;      // 落盘间隔
const HISTORY_RETENTION_HOURS = 24;  // 启动时加载最近 N 小时
const HISTORY_FILE = path.join(__dirname, 'data-history.jsonl');
const history = [];      // [{ts, group, emt_VA, emt_IA, emt_kW, emt_TPF, emt_HZ, emt_kWh, dlq_IO}]
let lastHistoryWriteIdx = 0;  // 自上次落盘以来已写入的起始索引

function snapshotHistory(g) {
  // 取回路 g 的最新电表+断路器快照
  const d = state.groups[g];
  if (!d || !d.meter) return null;
  return {
    ts: new Date().toISOString(),
    group: g,
    emt_VA: d.meter.emt_VA,
    emt_IA: d.meter.emt_IA,
    emt_kW: d.meter.emt_kW,
    emt_TPF: d.meter.emt_TPF,
    emt_HZ: d.meter.emt_HZ,
    emt_kWh: d.meter.emt_kWh,
    dlq_IO: d.dlq ? d.dlq.dlq_IO : null,
  };
}

function recordHistory() {
  // 每收到一帧电表报文，触发一次三组快照记录
  // 设备每 10s 上报一轮，约 30 条/分钟，3 组共 90 条/分钟 → 1h ≈ 540 条，2h ≈ 1080 条
  const snap = new Date();
  for (const g of GROUPS) {
    const row = snapshotHistory(g);
    if (row) {
      history.push(row);
    }
  }
  if (history.length > HISTORY_MAX) {
    const drop = history.length - HISTORY_MAX;
    history.splice(0, drop);
    lastHistoryWriteIdx = Math.max(0, lastHistoryWriteIdx - drop);
  }
}

function flushHistory() {
  if (history.length === lastHistoryWriteIdx) return;
  const lines = history.slice(lastHistoryWriteIdx).map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFile(HISTORY_FILE, lines, (err) => {
    if (err) console.log(`[${ts()}] ❌ 历史落盘失败: ${err.message}`);
    else {
      lastHistoryWriteIdx = history.length;
      console.log(`[${ts()}] 💾 历史落盘: ${lines.split('\n').length - 1} 条 (总计 ${history.length})`);
    }
  });
}

function loadHistory() {
  // 启动时从 JSONL 读最近 24h 数据入内存
  if (!fs.existsSync(HISTORY_FILE)) {
    console.log(`[${ts()}] 📁 历史文件不存在，跳过加载: ${HISTORY_FILE}`);
    return;
  }
  try {
    const content = fs.readFileSync(HISTORY_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const cutoff = Date.now() - HISTORY_RETENTION_HOURS * 3600 * 1000;
    let loaded = 0;
    for (const line of lines) {
      try {
        const r = JSON.parse(line);
        if (new Date(r.ts).getTime() < cutoff) continue;
        history.push(r);
        loaded++;
      } catch {}
    }
    if (history.length > HISTORY_MAX) {
      history.splice(0, history.length - HISTORY_MAX);
    }
    lastHistoryWriteIdx = history.length;
    console.log(`[${ts()}] 📂 已加载历史: ${loaded} 条 (24h 内, 内存 ${history.length})`);
  } catch (e) {
    console.log(`[${ts()}] ❌ 历史加载失败: ${e.message}`);
  }
}

// ---------- MQTT 客户端 ----------
const client = mqtt.connect(BROKER, {
  username: USER,
  password: PASS,
  clientId: 'bridge_' + Math.random().toString(16).substring(2, 10),
  reconnectPeriod: 5000,
  connectTimeout: 10000,
  clean: true,
});

client.on('connect', () => {
  state.brokerConnected = true;
  console.log(`[${ts()}] ✅ MQTT已连接 ${BROKER}，订阅 ${TOPIC}`);
  client.subscribe(TOPIC, { qos: 0 });
  pushEvent('桥接服务已连接 MQTT 服务器');
});
client.on('reconnect', () => console.log(`[${ts()}] 🔄 MQTT重连中...`));
client.on('error', (e) => {
  state.brokerConnected = false;
  console.log(`[${ts()}] ❌ MQTT错误: ${e.message}`);
  pushEvent('MQTT连接错误: ' + e.message);
});
client.on('close', () => { state.brokerConnected = false; console.log(`[${ts()}] 🔌 MQTT连接关闭`); });

client.on('message', (topic, payload) => {
  let msg;
  try { msg = JSON.parse(payload.toString()); } catch (e) { return; }
  if (msg.MsgType !== 'pdx_post_emt' && msg.MsgType !== 'pdx_post_dlq') return;
  if (IMEI_FILTER && msg.IMEI !== IMEI_FILTER) return;

  state.packetCount++;
  state.lastPacketTime = Date.now();
  state.imei = msg.IMEI;
  const addr = msg.rs485_addr;

  if (msg.MsgType === 'pdx_post_emt') {
    const g = METER_ADDR_TO_GROUP[addr];
    if (g) {
      const d = state.groups[g];
      const scaled = scaleMeter(msg);
      // 【2026-08-31 新增】异常帧过滤：电压/电流换算后超过 1000（或非有限数/缺失）→ 整帧忽略，不更新
      //   原因：坏帧/传感器异常会产生离谱数值，上屏会误导运维；保留最后正常值，仅推送告警事件
      const vaAbnormal = !Number.isFinite(scaled.emt_VA) || scaled.emt_VA > ABNORMAL_VA_LIMIT;
      const iaAbnormal = !Number.isFinite(scaled.emt_IA) || scaled.emt_IA > ABNORMAL_IA_LIMIT;
      if (vaAbnormal || iaAbnormal) {
        const fmtVal = (v, unit, limit) => {
          if (v === undefined) return '字段缺失';
          if (!Number.isFinite(v)) return String(v);   // NaN/Infinity
          return `${v}${unit}(>${limit}${unit})`;
        };
        const why = [];
        if (vaAbnormal) why.push(`VA=${fmtVal(scaled.emt_VA, 'V', ABNORMAL_VA_LIMIT)}`);
        if (iaAbnormal) why.push(`IA=${fmtVal(scaled.emt_IA, 'A', ABNORMAL_IA_LIMIT)}`);
        pushEvent(`回路${g} 收到异常电表帧已忽略（${why.join(', ')}）`, 'alert');
        console.log(`[${ts()}] ⚠️ 回路${g} 异常电表帧忽略: ${why.join(', ')}（保持最后正常值）`);
        broadcast(); // 异常告警事件推送给看板
        return;      // 不更新 state（meter/updatedAt 保持最后正常值），不入历史
      }
      d.meter = scaled;
      d.meterRaw = msg;
      d.updatedAt = Date.now();
      // 【2026-08-31 新增】阈值告警检测（电压/电流/功率超限）
      const VA = d.meter.emt_VA, IA = d.meter.emt_IA, kW = d.meter.emt_kW;
      if (VA > 240) pushEvent(`回路${g} 过压 ${VA.toFixed(1)}V (>240V)`, 'alert');
      else if (VA < 200 && VA > 0) pushEvent(`回路${g} 欠压 ${VA.toFixed(1)}V (<200V)`, 'alert');
      if (IA > 50) pushEvent(`回路${g} 过流 ${IA.toFixed(2)}A (>50A)`, 'alert');
      if (kW > 8) pushEvent(`回路${g} 过功率 ${kW.toFixed(2)}kW (>8kW)`, 'alert');
      console.log(`[${ts()}] #${state.packetCount} 回路${g} 电表: ${msg.emt_VA/100}V ${msg.emt_IA/100}A ${msg.emt_kW/1000}kW cosφ${msg.emt_TPF/100} ${msg.emt_kWh/100}kWh`);
      recordHistory(); // 【2026-08-31 新增】电表报到达则记录一次三组快照
    }
  } else if (msg.MsgType === 'pdx_post_dlq') {
    const g = DLQ_ADDR_TO_GROUP[addr];
    if (g) {
      const d = state.groups[g];
      d.dlq = { dlq_IO: msg.dlq_IO, online: msg.online };
      d.dlqRaw = msg;
      d.updatedAt = Date.now();
      console.log(`[${ts()}] #${state.packetCount} 回路${g} 断路器: ${msg.dlq_IO === 1 ? '合闸' : '分闸'}`);
    }
  }
  broadcast();
});

// ---------- 远程控制（合闸/分闸） ----------
// 【2026-08-31 新增】前端 POST /api/control → 发布 MQTT 控制报文到厂商服务器
//   请求体: { group: 1, action: 'on'|'off', imei?: '网关IMEI（可选，缺省用已识别的）' }
//   说明: 控制报文格式按协议 V1_260723 构造；若厂商实际格式有出入，仅需调整此处
function handleControl({ group, action, imei }) {
  if (!CONTROL_ENABLED) return { ok: false, error: '控制功能已禁用（CONTROL_ENABLED=false）' };
  if (!client.connected) return { ok: false, error: 'MQTT 未连接，无法下发控制指令' };
  const g = parseInt(group, 10);
  const addr = GROUP_TO_DLQ_ADDR[g];
  if (!addr) return { ok: false, error: `无效回路号: ${group}（仅支持 1/2/3）` };
  if (action !== 'on' && action !== 'off') return { ok: false, error: `无效动作: ${action}（仅支持 on/off）` };
  const gwId = imei || state.imei;
  if (!gwId) return { ok: false, error: '未获取到网关 IMEI，无法构造控制报文' };

  const topic = `/wlw_szxn_pdx/${gwId}/server_ctrl`;
  const payload = {
    MsgType: action === 'on' ? 'set_dlq_IO_on' : 'set_dlq_IO_off',
    GWID: gwId,
    MeterAdr: addr,
  };
  client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) pushEvent(`回路${g} ${action === 'on' ? '合闸' : '分闸'} 指令发布失败: ${err.message}`, 'ctrl');
  });
  pushEvent(`回路${g} ${action === 'on' ? '合闸' : '分闸'} 指令已下发（MeterAdr=${addr}）`, 'ctrl');
  console.log(`[${ts()}] 🎛️ [控制] 回路${g} ${action === 'on' ? '合闸' : '分闸'} → ${topic} ${JSON.stringify(payload)}`);
  broadcast(); // 立即推送给看板（含新事件）
  return { ok: true, group: g, action, addr, topic, payload };
}

// ---------- HTTP + WebSocket ----------
const DASHBOARD_FILE = path.join(__dirname, 'power-dashboard.html'); // 【2026-08-31 新增】静态托管看板
const server = http.createServer((req, res) => {
  // 简单 CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 【2026-08-31 新增】浏览器访问根路径直接打开看板页面
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(DASHBOARD_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('dashboard not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // 【2026-08-31 新增】favicon 占位，避免浏览器 404 请求噪音
  if (req.url === '/favicon.ico') {
    res.writeHead(204); res.end();
    return;
  }

  if (req.url === '/api/state' || req.url.startsWith('/api/state?')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  // 【2026-08-31 新增】历史数据查询 API
  //   用法: GET /api/history?hours=2&group=1
  //   参数: hours 默认 1（1h），最大 24；group 可选（不传=全部3组）
  if (req.url.startsWith('/api/history')) {
    const u = new URL(req.url, 'http://localhost');
    const hours = Math.min(24, Math.max(0.1, parseFloat(u.searchParams.get('hours') || '1')));
    const group = u.searchParams.get('group');
    const cutoff = Date.now() - hours * 3600 * 1000;
    let rows = history.filter(r => new Date(r.ts).getTime() >= cutoff);
    if (group) rows = rows.filter(r => r.group === parseInt(group, 10));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      hours, group: group ? parseInt(group, 10) : null,
      count: rows.length, history: rows, totalInMemory: history.length,
    }));
    return;
  }

  // 【2026-08-31 新增】远程合闸/分闸控制 API
  //   用法: POST /api/control  body: {"group":1,"action":"on"}（action: on=合闸 / off=分闸）
  if (req.method === 'OPTIONS') {   // 跨域预检（后续如需从其他源页面调用）
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/api/control') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (e) {}
      if (!parsed) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }));
        return;
      }
      const result = handleControl(parsed);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

const wss = new WebSocketServer({ server });
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'hello', state: snapshot() })); // 新连接先发全量快照
  ws.on('close', () => clients.delete(ws));
});

function snapshot() {
  return {
    type: 'state',
    brokerConnected: state.brokerConnected,
    // 【2026-09-01 修改】broker 地址动态下发前端显示，不再硬编码在 HTML 里
    //   原因：仓库公开提交，服务器地址属客户信息，入库时以占位符代替，运行时动态显示
    broker: BROKER,
    imei: state.imei,
    packetCount: state.packetCount,
    lastPacketTime: state.lastPacketTime,
    groups: state.groups,
    events: state.events,
  };
}
function broadcast() {
  const data = JSON.stringify(snapshot());
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// 【2026-08-31 新增】启动时加载历史 + 定期落盘
loadHistory();
setInterval(flushHistory, HISTORY_FLUSH_MS);

server.listen(PORT, '0.0.0.0', () => {   // 【2026-08-31 修改】监听所有网卡，局域网设备可访问
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
    }
  }
  console.log(`\n🌐 桥接服务已启动`);
  console.log(`   📺 看板页面:        http://localhost:${PORT}   (浏览器直接打开)`);
  if (ips.length) {
    for (const ip of ips) console.log(`   📺 局域网访问:      http://${ip}:${PORT}`);
  }
  console.log(`   看板WebSocket:   ws://${ips[0] || 'localhost'}:${PORT}`);
  console.log(`   状态快照API:     http://localhost:${PORT}/api/state`);
  console.log(`   历史数据API:     http://localhost:${PORT}/api/history?hours=1&group=1`);
  console.log(`   控制API(POST):   http://localhost:${PORT}/api/control  body:{"group":1,"action":"on|off"}  ${CONTROL_ENABLED ? '✅ 已启用' : '⛔ 已禁用'}`);
  console.log(`   目标MQTT:        ${BROKER} (${USER}@...)`);
  console.log(`   历史落盘文件:    ${HISTORY_FILE}\n`);
});

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

// 兜底：定期打印连接状态
setInterval(() => {
  if (state.lastPacketTime && Date.now() - state.lastPacketTime > 60000) {
    console.log(`[${ts()}] ⚠️ 已 ${Math.round((Date.now()-state.lastPacketTime)/1000)}s 未收到设备数据`);
  }
}, 30000);
