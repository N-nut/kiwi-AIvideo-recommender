param([int]$Port = 8000, [switch]$Baseline)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$kiwiPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $kiwiPython)) { throw '请先按 README 初始化 Python 环境。' }
if ($Baseline) { & $kiwiPython -X utf8 scripts/run.py --port $Port --baseline }
else { & $kiwiPython -X utf8 scripts/run.py --port $Port }
