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

## 服务器部署（Linux / Ubuntu 示例）

> 项目已带 `package.json`，服务器上只需 `npm install` 即可，无需手工装包。

**1. 安装 Node.js（≥ 18，推荐 22 LTS）**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # 确认输出 v22.x
```

**2. 获取代码（二选一）**

```bash
# 方式 A：从 GitHub 拉取（公开仓库）
git clone https://github.com/styeven/sty_pdx.git
cd sty_pdx

# 方式 B：本机打包上传（scp 到服务器后解压）
#   zip -r sty_pdx.zip 除 node_modules/.git/data-history.jsonl/config.local.json 外的全部文件
```

**3. 创建本地配置（clone 后没有 config.local.json，必须手动创建）**

```bash
cp config.example.json config.local.json
nano config.local.json   # 填入厂商 MQTT 真实地址/账号/密码
```

> `config.local.json` 被 git 忽略，不会从仓库下载；`data-history.jsonl` 同样不入库，不带上则历史从零开始记录。

**4. 安装依赖并启动**

```bash
npm install              # 只装 mqtt 和 ws 两个包
node bridge-server.js 3010
```

看到 `brokerConnected: true` 即连接成功。浏览器访问 `http://服务器IP:3010` 验证看板。

**5. 进程守护（推荐 pm2，崩溃自动重启 + 开机自启）**

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js     # 使用仓库自带的 pm2 配置
pm2 save                          # 保存进程列表
pm2 startup                       # 按提示执行输出的命令，实现开机自启
pm2 logs pdx-bridge               # 查看日志（也落在 ./logs/out.log）
```

常用命令：`pm2 status` / `pm2 restart pdx-bridge` / `pm2 stop pdx-bridge`

**6. 防火墙开放端口**

```bash
sudo ufw allow 3010/tcp
```

**7. 更新代码**

```bash
git pull
pm2 restart pdx-bridge
```

**8. 可选：域名 + HTTPS（nginx 反向代理）**

```bash
sudo apt-get install -y nginx
```

nginx 站点配置（`/etc/nginx/sites-available/sty_pdx`）：

```nginx
server {
    listen 80;
    server_name 你的域名;
    location / {
        proxy_pass http://127.0.0.1:3010;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;      # WebSocket 必需
        proxy_set_header Connection "upgrade";       # WebSocket 必需
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
    }
}
```

启用后 `sudo ln -s /etc/nginx/sites-available/sty_pdx /etc/nginx/sites-enabled/ && sudo nginx -s reload`，再用 certbot 免费签发 HTTPS 证书即可。**注意：nginx 反代必须保留 `Upgrade` 相关头，否则页面实时曲线不刷新。**

**Windows 服务器**：装 Node.js 后同样 `npm install` + `node bridge-server.js 3010`，用 NSSM 或任务计划程序做开机自启即可。

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
package.json          依赖声明（npm install 用）
ecosystem.config.js   pm2 进程守护配置（服务器部署用）
config.example.json   配置模板（可入库）
config.local.json     本机真实配置（git 忽略，不入库）
data-history.jsonl    历史数据落盘（git 忽略，不入库）
subscribe-test.js / probe-mqtt.js / screenshot-*.js  调试与验证脚本
```
