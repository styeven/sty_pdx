# 智能配电箱电力数字化看板

塘下-数智新能 · 智能配电箱项目的电力数字化监控看板。

## 功能

- 3 组回路（电表 + 断路器）实时监控：闸位状态、电压、电流、功率、功率因数、频率、电度
- 实时功率趋势曲线（最近 10 分钟），支持点击图例开关切换曲线显示
- 实时功率数据通过桥接服务从厂商 MQTT 服务器订阅，浏览器 WebSocket 接收
- 远程控制：合闸 / 分闸（带二次确认弹窗，按钮跟随数据源状态自动禁用）
- 异常帧过滤：电压/电流超 1000 的异常报文自动忽略，不上屏
- 历史数据归档（内存环形缓冲 + JSONL 落盘），离线 1 分钟判定

## 架构

```
设备 → 厂商MQTT服务器 → bridge-server.js → WebSocket → 浏览器看板
```

浏览器无法直连厂商原生 MQTT（未开放 WebSocket 端口），由 `bridge-server.js` 作为本地桥接层。

## 快速开始

1. 安装依赖（仅 `mqtt` 和 `ws` 两个包）：
   ```bash
   npm install mqtt ws
   ```
2. 创建本地配置 `config.local.json`（模板见 `config.example.json`）：
   ```json
   {
     "broker": "mqtt://你的服务器:端口",
     "user": "用户名",
     "pass": "密码",
     "topic": "/wlw_szxn_pdx/#",
     "imeiFilter": null,
     "port": 3010
   }
   ```
   > `config.local.json` 已被 `.gitignore` 忽略，不会提交到仓库，请勿把真实凭据写入其他文件。
3. 启动桥接服务：
   ```bash
   node bridge-server.js
   ```
4. 浏览器打开 <http://localhost:3010>（局域网访问用本机 IP，如 <http://192.168.x.x:3010>）

## 远程控制

- 接口：`POST /api/control`，请求体 `{"group": 1, "action": "on|off"}`
- 控制报文按协议 V1_260723 构造（`set_dlq_IO_on` / `set_dlq_IO_off`），若厂商格式有出入仅需调整 `handleControl()`
- 服务端总开关 `CONTROL_ENABLED` 置 `false` 可整体禁用

## 其他接口

| 接口 | 说明 |
|---|---|
| `GET /api/state` | 实时状态快照 |
| `GET /api/history?hours=1&group=1` | 历史曲线数据 |
| `GET /api/control` | 控制（见上） |

## 目录结构

```
bridge-server.js      桥接服务（MQTT 订阅 + WebSocket + HTTP）
power-dashboard.html  看板前端（静态托管）
config.example.json   配置模板（可入库）
config.local.json     本机真实配置（git 忽略，不入库）
data-history.jsonl    历史数据落盘（git 忽略，不入库）
subscribe-test.js / probe-mqtt.js / screenshot-*.js  调试与验证脚本
```
