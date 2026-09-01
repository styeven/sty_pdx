// 【2026-08-31 新增】MQTT 服务器端口探测脚本
//   原因：确认厂商服务器是原生 MQTT 还是 MQTT-over-WebSocket，决定浏览器能否直连
// 【2026-09-01 修改】服务器地址/账号密码从 config.local.json 读取（该文件被 .gitignore 忽略）
//   原因：仓库公开提交，客户服务器与账号密码属敏感信息，不入库
const net = require('net');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));
const broker = (cfg.broker || 'mqtt://127.0.0.1:1883').replace(/^mqtt:\/\//, '');
const [HOST, PORT_STR] = broker.split(':');
const PORT = parseInt(PORT_STR || '1883', 10);
const USER = cfg.user || '';
const PASS = cfg.pass || '';

function buildConnectPacket(clientId, username, password) {
  const protoName = Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54]); // "MQTT"
  const level = Buffer.from([0x04]); // v3.1.1
  // flags: username(0x80) + password(0x40) + cleanSession(0x02) = 0xC2
  const flags = Buffer.from([0xC2]);
  const keepalive = Buffer.from([0x00, 0x3C]); // 60s
  const cid = Buffer.from(clientId, 'utf8');
  const cidLen = Buffer.from([cid.length >> 8, cid.length & 0xFF]);
  const uname = Buffer.from(username, 'utf8');
  const unameLen = Buffer.from([uname.length >> 8, uname.length & 0xFF]);
  const pwd = Buffer.from(password, 'utf8');
  const pwdLen = Buffer.from([pwd.length >> 8, pwd.length & 0xFF]);

  const payload = Buffer.concat([cidLen, cid, unameLen, uname, pwdLen, pwd]);
  const variableHeader = Buffer.concat([protoName, level, flags, keepalive]);
  const remaining = variableHeader.length + payload.length;
  let rl;
  if (remaining < 128) rl = Buffer.from([remaining]);
  else if (remaining < 16384) rl = Buffer.from([(remaining & 0x7F) | 0x80, remaining >> 7]);
  else rl = Buffer.from([(remaining & 0x7F) | 0x80, ((remaining >> 7) & 0x7F) | 0x80, remaining >> 14]);
  return Buffer.concat([Buffer.from([0x10]), rl, variableHeader, payload]);
}

function testRawMqtt(cb) {
  const sock = net.connect({ host: HOST, port: PORT }, () => {
    sock.write(buildConnectPacket('probe_' + Date.now(), USER, PASS));
    setTimeout(() => { sock.destroy(); cb('timeout'); }, 5000);
  });
  sock.on('data', (d) => {
    const hex = d.toString('hex');
    const firstByte = d[0];
    if (firstByte === 0x20) {
      // CONNACK: byte2 = sessionPresent, byte3 = return code (0=accepted)
      cb('MQTT_CONNACK rc=' + d[2] + ' (0=接受)');
    } else {
      cb('收到非CONNACK字节: 0x' + firstByte.toString(16) + ' 完整hex前40: ' + hex.slice(0, 80));
    }
    sock.destroy();
  });
  sock.on('error', (e) => cb('ERR:' + e.code));
  sock.on('close', () => { /* handled */ });
}

function testWebSocket() {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket('ws://' + HOST + ':' + PORT + '/mqtt');
      const t = setTimeout(() => { try { ws.close(); } catch (e) {} resolve('WS握手: 超时(可能非WS端口)'); }, 6000);
      ws.onopen = () => { clearTimeout(t); resolve('WS握手: 成功! 该端口支持MQTT-over-WebSocket'); try { ws.close(); } catch (e) {} };
      ws.onerror = (e) => { clearTimeout(t); resolve('WS握手失败: ' + (e && e.message || 'error')); };
      ws.onclose = (e) => { clearTimeout(t); resolve('WS连接被关闭 code=' + e.code + ' reason=' + e.reason); };
    } catch (e) {
      resolve('WS异常: ' + e.message);
    }
  });
}

async function main() {
  console.log('=== 测试1: 原生MQTT (TCP ' + HOST + ':' + PORT + ') ===');
  await new Promise((r) => testRawMqtt((msg) => { console.log(msg); r(); }));
  console.log('=== 测试2: WebSocket握手 (ws://' + HOST + ':' + PORT + '/mqtt) ===');
  const r2 = await testWebSocket();
  console.log(r2);
  process.exit(0);
}

main();
