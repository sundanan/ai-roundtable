@echo off
chcp 65001 >nul
rem AI 圆桌 · Windows 常驻服务配置（当前用户生效，可重复运行）：
rem 注册计划任务：登录自动启动 + 崩溃后每 10 秒自动重启（最多 999 次），并立即启动。
rem 位置自适应：本脚本随安装包发布在 resources\ 下，程序在上一级目录。
setlocal
set "APP_DIR=%~dp0.."
set "EXE=%APP_DIR%\ai-roundtable.exe"
if not exist "%EXE%" (
  echo 错误：未找到 %EXE%（本脚本应位于 AI 圆桌 resources\ 目录内运行）
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$exe = '%EXE%';" ^
  "$action = New-ScheduledTaskAction -Execute $exe;" ^
  "$trigger = New-ScheduledTaskTrigger -AtLogOn;" ^
  "$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero);" ^
  "Register-ScheduledTask -TaskName 'AI圆桌' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null"

if %errorlevel%==0 (
  echo ✓ 已注册计划任务“AI圆桌”：登录自启，崩溃每 10 秒自动重启
  schtasks /run /tn "AI圆桌"
  echo 日常管理：任务计划程序中查看“AI圆桌”；删除：schtasks /delete /tn "AI圆桌" /f
) else (
  echo 注册失败：请右键“以管理员身份运行”重试，或检查 PowerShell 是否可用
)
pause
