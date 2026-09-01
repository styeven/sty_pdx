// pm2 进程守护配置
// 【2026-09-01 新增】服务器部署用：pm2 start ecosystem.config.js
//   原因：保证桥接服务崩溃自动重启、开机自启、日志落盘
//   用法：npm install -g pm2 && pm2 start ecosystem.config.js && pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: 'pdx-bridge',
      script: 'bridge-server.js',
      args: '3010',          // HTTP/WebSocket 端口
      instances: 1,          // 单实例即可（内部已有 MQTT 连接，勿开 cluster）
      exec_mode: 'fork',
      autorestart: true,     // 崩溃自动重启
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true             // 日志行加时间戳
    }
  ]
};
