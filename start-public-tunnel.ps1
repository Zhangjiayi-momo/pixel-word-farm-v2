$ErrorActionPreference = "Stop"
$cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflared) {
    Write-Host "未安装 cloudflared。请先从 Cloudflare 官方渠道安装后重新运行。" -ForegroundColor Yellow
    exit 1
}
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$server = Start-Process -FilePath "python" -ArgumentList "server.py", "--host", "0.0.0.0", "--port", "8000" -WorkingDirectory $root -WindowStyle Hidden -PassThru
try {
    Write-Host "本地课堂服务已启动。正在创建临时公网链接……" -ForegroundColor Green
    & $cloudflared.Source tunnel --url http://127.0.0.1:8000
}
finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
