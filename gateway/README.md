# Hive Gateway（自建 MVP）

这是 Hive 远程访问的自建网关 MVP。它只负责：

- `hive remote login` 的一次性授权码和 daemon Token；
- 配对确认时登记设备；
- 在 daemon、pair 和 device WebSocket 之间转发控制帧和加密二进制帧。
- 托管 `web/dist/remote.html` 手机入口；手机配对后通过同一条端到端加密通道访问 Hive 的 `/api/*` 和 `/ws/*`。

网关不会解密 Hive 数据，也不会访问本机 Workspace。当前版本是单用户 MVP，管理 Token 等同于网关所有权凭据。

## 启动

在仓库根目录执行：

```powershell
$env:HIVE_GATEWAY_OWNER_TOKEN = '替换为至少 32 位随机字符串'
pnpm gateway:dev
```

默认监听 `127.0.0.1:8787`。要让手机访问，需要把网关部署在有 HTTPS/WSS 的服务器上，并设置：

```powershell
$env:HIVE_GATEWAY_HOST = '0.0.0.0'
$env:HIVE_GATEWAY_PORT = '8787'
$env:HIVE_GATEWAY_DATA_DIR = 'D:\HiveGatewayData'
# 如果从其他目录启动网关，显式指定前端构建目录：
$env:HIVE_WEB_DIST_DIR = 'D:\桌面\hive\web\dist'
```

然后让本机 Hive 使用自建地址：

```powershell
hive remote login --gateway https://你的网关域名
```

打开终端打印的 `/daemon/approve?code=...` 页面，输入 `HIVE_GATEWAY_OWNER_TOKEN` 批准本机。

## 手机访问

1. 在网关根地址登录管理 Token；
2. 打开 `/app`，或者在 `/machines` 中点击在线机器的“打开 Hive 控制台”；
3. 在电脑 Hive 的“远程访问”面板点击“配对手机”，复制两行配对数据；
4. 在手机 `/app` 粘贴配对数据，并在电脑端核对相同的 SAS 短码后确认；
5. 配对完成后，手机会加载完整 Hive 界面，Workspace、Team、Tasks 和终端请求都通过加密设备通道转发。

本地开发可以先用 `pnpm build:web`，再启动 `pnpm gateway:dev`。生产环境应使用 HTTPS/WSS 反向代理；临时 Quick Tunnel 仅适合联调。

## 当前限制

- 目前为单用户模型，管理 Token 等同于所有权凭据；
- 尚未加入 GitHub / Google OAuth；
- 生产部署前应放在反向代理后启用 HTTPS/WSS，并限制网关数据目录权限。
