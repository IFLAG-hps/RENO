param(
  [int]$ApiPort = 3000,
  [int]$LocalStackPort = 4566
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Get-ContainerStatus([string]$name) {
  docker ps -a --filter "name=^$name$" --format '{{.Status}}'
}

function Ensure-LocalStack {
  $status = Get-ContainerStatus 'reno-localstack'
  if ($status -and $status -notlike 'Up *') {
    docker start reno-localstack | Out-Null
  } elseif (-not $status) {
    docker run -d --name reno-localstack `
      -p "${LocalStackPort}:4566" `
      -e SERVICES=dynamodb,s3,ses `
      -e DEBUG=0 `
      localstack/localstack:4.4.0 | Out-Null
  }
}

function Ensure-Api {
  $status = Get-ContainerStatus 'reno-api'
  if ($status -and $status -notlike 'Up *') {
    docker start reno-api | Out-Null
  } elseif (-not $status) {
    $apiKey = if ($env:OPENAI_API_KEY) { $env:OPENAI_API_KEY } else { '' }
    docker run -d --name reno-api `
      -p "${ApiPort}:3000" `
      --add-host host.docker.internal:host-gateway `
      -e AWS_ENDPOINT_URL=http://host.docker.internal:$LocalStackPort `
      -e AWS_DEFAULT_REGION=ap-northeast-1 `
      -e OPENAI_API_KEY=$apiKey `
      -e OPENAI_MODEL=$(if ($env:OPENAI_MODEL) { $env:OPENAI_MODEL } else { 'gpt-5-mini' }) `
      -e PORT=3000 `
      -e LOCAL_PIN=5678 `
      -v "${repo}:/workspace" `
      -w /workspace `
      python:3.12-slim `
      sh -lc 'pip install -q boto3 && python backend/local_server.py' | Out-Null
  }
}

Ensure-LocalStack
Start-Sleep -Seconds 3
Ensure-Api

for ($i = 0; $i -lt 30; $i++) {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$ApiPort/health" -TimeoutSec 2
    if ($health.ok) {
      Write-Host "Local API: http://127.0.0.1:$ApiPort/agent"
      Write-Host "Local PIN: 5678"
      Write-Host "Frontend config: assets/reno-config.js"
      exit 0
    }
  } catch {}
  Start-Sleep -Seconds 2
}

docker logs reno-api
throw 'Local API did not become ready.'
