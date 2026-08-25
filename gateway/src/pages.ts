const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

export const shell = (title: string, body: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Hive Gateway</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#171717;color:#f5f5f5}
body{max-width:560px;margin:0 auto;padding:40px 20px;background:#171717;min-height:100vh;box-sizing:border-box}
main{background:#242424;border:1px solid #3a3a3a;border-radius:16px;padding:24px;box-shadow:0 12px 40px #0005}
h1{margin:0 0 8px;font-size:24px}p{color:#b9b9b9;line-height:1.55}label{display:block;color:#cfcfcf;margin:18px 0 8px}
input{width:100%;box-sizing:border-box;background:#161616;color:#fff;border:1px solid #4a4a4a;border-radius:8px;padding:12px;font:inherit}
button{margin-top:18px;border:0;border-radius:8px;background:#4d70df;color:#fff;padding:11px 16px;font:inherit;cursor:pointer}
.hint{font-size:13px;color:#999}.code{font:600 18px ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.12em;background:#161616;border-radius:8px;padding:14px;word-break:break-all}
.ok{color:#8fd694}.warn{color:#e9b36c}
</style></head><body><main>${body}</main></body></html>`

export const gatewayHomePage = () =>
  shell(
    'Hive Gateway',
    `<h1>Hive Gateway</h1><p>自建单用户网关已启动。它只负责认证和加密连接中继，Hive Agent 与 Workspace 仍留在你的电脑上。</p>
    <form method="post" action="/auth/login"><label for="token">网关管理 Token</label><input id="token" name="token" type="password" autocomplete="current-password" required><button type="submit">登录</button></form>
    <p class="hint">请将 HIVE_GATEWAY_OWNER_TOKEN 设置为你自己的长随机字符串。</p>`
  )

export const daemonApprovalPage = (code: string) =>
  shell(
    'Approve Hive machine',
    `<h1>确认 Hive 设备</h1><p>确认后，终端中的 Hive 才会获得网关连接 Token。</p><div class="code">${escapeHtml(code)}</div>
    <form method="post" action="/daemon/approve"><input type="hidden" name="code" value="${escapeHtml(code)}"><label for="token">网关管理 Token</label><input id="token" name="token" type="password" required><button type="submit">批准此设备</button></form>`
  )

export const approvedPage = () =>
  shell('Approved', '<h1 class="ok">已批准</h1><p>返回终端，Hive 会自动完成登录。</p>')
