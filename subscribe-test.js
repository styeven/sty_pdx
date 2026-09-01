// 【2026-08-31 新增】真实 MQTT 数据订阅测试脚本
//   原因：验证能否从厂商服务器订阅到设备真实上报数据
//   用法：node subscribe-test.js [监听秒数]，默认 25 秒
// 【2026-09-01 修改】连接凭据从 config.local.json 读取（该文件被 .gitignore 忽略）
//   原因：仓库公开提交，账号密码/服务器地址属敏感信息，不入库
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.local.json'), 'utf8'));
const BROKER = cfg.broker || 'mqtt://127.0.0.1:1883';
const USER = cfg.user || '';
const PASS = cfg.pass || '';
const TOPIC = '/wlw_szxn_pdx/#';
const WATCH_SEC = parseInt(process.argv[2] || '25', 10);

const client = mqtt.connect(BROKER, {
  username: USER,
  password: PASS,
  clientId: 'watch_' + Math.random().toString(16).substring(2, 10),
  reconnectPeriod: 3000,
  connectTimeout: 10000,
  clean: true,
});

let msgCount = 0;

client.on('connect', () => {
  console.log(`[${new Date().toLocaleTimeString()}] ✅ 已连接 ${BROKER}，订阅 ${TOPIC}`);
  client.subscribe(TOPIC, { qos: 0 }, (err) => {
    if (err) console.log('订阅失败:', err.message);
    else console.log(`⏳ 监听 ${WATCH_SEC} 秒，等待设备上报...`);
  });
});

client.on('message', (topic, payload) => {
  msgCount++;
  let text = payload.toString();
  let pretty = text;
  try { pretty = JSON.stringify(JSON.parse(text), null, 0); } catch (e) {}
  console.log(`\n📨 [${new Date().toLocaleTimeString()}] #${msgCount} 主题: ${topic}`);
  console.log(`   报文: ${pretty.length > 400 ? pretty.slice(0, 400) + '...' : pretty}`);
});

client.on('error', (e) => console.log('❌ 错误:', e.message));
client.on('reconnect', () => console.log('🔄 重连中...'));
client.on('close', () => console.log('🔌 连接关闭'));

setTimeout(() => {
  console.log(`\n===== 监听结束，共收到 ${msgCount} 条真实报文 =====`);
  client.end(true, () => process.exit(0));
}, WATCH_SEC * 1000);

// 兜底：60秒无任何消息也退出
setTimeout(() => {
  if (msgCount === 0) { console.log('超时未收到数据，退出'); client.end(true, () => process.exit(1)); }
}, WATCH_SEC * 1000 + 5000);
