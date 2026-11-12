# pi-upstream-filter 代理模式 启动/停止/状态
# 双击入口：start-proxy.vbs / stop-proxy.vbs；命令行：powershell -File scripts\proxy.ps1 -Action start|stop|status [-Quiet]
param(
  [ValidateSet("start", "stop", "status")][string]$Action = "start",
  [switch]$Quiet
)
$ErrorActionPreference = "Stop"
$Port = 8788
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ServerJs = Join-Path $RepoRoot "server.cjs"
$LocalConfig = Join-Path $PSScriptRoot "proxy.local.ps1"

$script:wsh = $null
function Notify([string]$Text, [int]$Seconds = 8) {
  if ($Quiet) { Write-Host $Text; return }
  if (-not $script:wsh) { $script:wsh = New-Object -ComObject WScript.Shell }
  $script:wsh.Popup($Text, $Seconds, "pi-upstream-filter 代理", 64) | Out-Null
  Write-Host $Text
}

function Get-Listener {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

switch ($Action) {
  "start" {
    if (-not (Test-Path $LocalConfig)) {
      Copy-Item "$LocalConfig.example" $LocalConfig
      Notify "首次使用：已生成 scripts\proxy.local.ps1。`n请用记事本打开它，把 `$UpstreamBaseUrl 改成你的中转站地址，保存后再次双击启动。"
      exit 1
    }
    . $LocalConfig
    if (-not $UpstreamBaseUrl -or $UpstreamBaseUrl -like "*your-relay*") {
      Notify "请先编辑 scripts\proxy.local.ps1，把 `$UpstreamBaseUrl 改成你的中转站地址。"
      exit 1
    }
    if (Get-Listener) { Notify "代理已在运行（端口 $Port），无需重复启动。"; exit 0 }
    $env:PORT = "$Port"
    $env:UPSTREAM_BASE_URL = $UpstreamBaseUrl
    if ($ApiKey) { $env:UPSTREAM_API_KEY = $ApiKey }
    else { Remove-Item Env:UPSTREAM_API_KEY -ErrorAction SilentlyContinue }
    if ($Debug) {
      $env:FILTER_DEBUG = "1"
      $env:FILTER_LOG_FILE = Join-Path $PSScriptRoot "proxy.log"
    } else {
      Remove-Item Env:FILTER_DEBUG, Env:FILTER_LOG_FILE -ErrorAction SilentlyContinue
    }
    try {
      Start-Process -FilePath "node" -ArgumentList ('"{0}"' -f $ServerJs) -WindowStyle Hidden
    } catch {
      Notify "启动失败：找不到 node，请确认 Node.js 已安装并在 PATH 中。`n$($_.Exception.Message)"
      exit 1
    }
    $ok = $false
    foreach ($i in 1..20) {
      Start-Sleep -Milliseconds 300
      try {
        $r = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
        if ($r.ok) { $ok = $true; break }
      } catch {}
    }
    if ($ok) {
      Notify ("代理已启动：http://127.0.0.1:{0} → {1}`n停止：双击 scripts\stop-proxy.vbs" -f $Port, $UpstreamBaseUrl)
    } else {
      Notify "代理进程已拉起但 healthz 未就绪，请查看 scripts\proxy.log 或直接在终端运行 npm run proxy 排错。"
      exit 1
    }
  }
  "stop" {
    $l = Get-Listener
    if (-not $l) { Notify "代理未在运行。"; exit 0 }
    try {
      $r = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
      if (-not $r.version) { throw "not-ours" }
    } catch {
      Notify "端口 $Port 被其他程序占用（PID $($l.OwningProcess)），已跳过停止以免误杀。"
      exit 1
    }
    Stop-Process -Id $l.OwningProcess -Force
    Notify ("代理已停止（PID {0}）。" -f $l.OwningProcess)
  }
  "status" {
    try {
      $r = Invoke-RestMethod "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
      Notify ("运行中：v{0} → {1}`n已代理 {2} 个请求，错误 {3} 次。" -f $r.version, $r.upstream, $r.stats.proxied, $r.stats.errors)
    } catch { Notify "未在运行（端口 $Port 无响应）。" }
  }
}
