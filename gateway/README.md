# Hive Gateway（自建 MVP）

这是 Hive 远程访问的自建网关 MVP。它只负责：

- `hive remote login` 的一次性授权码和 daemon Token；
- 配对确认时登记设备；
- 在 daemon、pair 和 device WebSocket 之间转发控制帧和加密二进制帧。

网关不会解密 Hive 数据，也不会访问本机 Workspace。当前版本是单用户 MVP，手机端 UI 仍在后续阶段实现。

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
```

然后让本机 Hive 使用自建地址：

```powershell
hive remote login --gateway https://你的网关域名
```

打开终端打印的 `/daemon/approve?code=...` 页面，输入 `HIVE_GATEWAY_OWNER_TOKEN` 批准本机。

## 当前限制

- 目前为单用户模型，管理 Token 等同于所有权凭据；
- 尚未加入 GitHub / Google OAuth；
- 尚未提供完整手机端 Hive UI；
- 生产部署前应放在反向代理后启用 HTTPS/WSS，并限制网关数据目录权限。
