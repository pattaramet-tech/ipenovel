param([switch]$KeepResources)

# Synthetic, local Docker release gate ONLY. Never loads .env, private plans,
# application credentials, an existing database volume or Docker socket.
$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testSuffix = [guid]::NewGuid().ToString('N').Substring(0, 12)
$testPrefix = "ipe-legacy-repair-$testSuffix"
$testNetwork = "$testPrefix-net"
$testDatabaseContainer = "$testPrefix-db"
$testRunnerContainer = "$testPrefix-node"
$testDatabaseName = "ipe_repair_test_$testSuffix"
$testPassword = "synthetic-$testSuffix-only"
$testLabel = "com.ipenovel.isolated-repair=$testSuffix"
$stagingParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stagingPath = Join-Path $stagingParent $testPrefix
$createdNetwork = $false
$createdDatabase = $false
$createdRunner = $false

# Freeze a proven local Windows Docker endpoint before creating anything. A
# user's current remote Docker context must never turn this into server work.
foreach ($variableName in @('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')) {
  if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($variableName))) {
    throw 'ISOLATED_TEST_REJECTS_AMBIENT_DOCKER_ENDPOINT_OVERRIDES'
  }
}
$testDockerContext = (& docker context show).Trim()
if ($LASTEXITCODE -ne 0 -or $testDockerContext -notmatch '^[A-Za-z0-9_.-]+$') { throw 'LOCAL_DOCKER_CONTEXT_NOT_PROVEN' }
$testDockerEndpoint = & docker context inspect $testDockerContext --format '{{.Endpoints.docker.Host}}'
if ($LASTEXITCODE -ne 0 -or $testDockerEndpoint -notin @('npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine')) {
  throw 'ISOLATED_TEST_REQUIRES_LOCAL_WINDOWS_DOCKER_NAMED_PIPE'
}

function Invoke-TestDocker {
  $dockerCommandArguments = @($args)
  & docker --context $testDockerContext @dockerCommandArguments
  if ($LASTEXITCODE -ne 0) { throw "ISOLATED_DOCKER_COMMAND_FAILED: $($dockerCommandArguments[0])" }
}

try {
  if (Test-Path -LiteralPath $stagingPath) { throw 'STAGING_ALREADY_EXISTS' }
  New-Item -ItemType Directory -Path $stagingPath | Out-Null

  # Read committed file inventory, then explicitly include the new uncommitted
  # repair files. Broad workspace/directory copies are deliberately forbidden.
  $sourcePaths = @(& git -C $repoPath ls-files -- scripts server shared drizzle)
  if ($LASTEXITCODE -ne 0) { throw 'GIT_SOURCE_INVENTORY_FAILED' }
  $sourcePaths += @(
    'package.json', 'pnpm-lock.yaml', 'tsconfig.json',
    'vitest.legacy-slip-repair.config.ts',
    'scripts/execute-legacy-slip-reference-repair.ts',
    'scripts/lib/legacySlipRepairExecution.ts',
    'scripts/lib/legacySlipRepairReconciliation.ts',
    'scripts/lib/legacySlipRepairTriggerVisibility.ts',
    'server/fixtures/legacySlipRepairIsolatedDatabase.ts',
    'server/legacySlipRepairMariaDb.integration.test.ts',
    'server/legacySlipRepairLinux.integration.test.ts'
  )
  foreach ($relativePath in ($sourcePaths | Sort-Object -Unique)) {
    if ($relativePath -match '(^|/)(\.|\.\.)($|/)' -or
        $relativePath -match '(^|/)\.' -or
        $relativePath -notmatch '\.(ts|tsx|mjs|js|json|sql|yaml)$') { continue }
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $repoPath $relativePath))
    if (-not $sourcePath.StartsWith("$repoPath$([IO.Path]::DirectorySeparatorChar)", [StringComparison]::OrdinalIgnoreCase)) { throw 'SOURCE_ESCAPES_REPOSITORY' }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      if ($relativePath -in @('scripts/lib/legacySlipRepairReconciliation.ts', 'scripts/lib/legacySlipRepairTriggerVisibility.ts')) { continue }
      throw "REQUIRED_SOURCE_MISSING: $relativePath"
    }
    if ((Get-Item -LiteralPath $sourcePath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SOURCE_SYMLINK_REJECTED' }
    $destinationPath = Join-Path $stagingPath $relativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $destinationPath) -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
  }

  Invoke-TestDocker network create --internal --label $testLabel $testNetwork
  $createdNetwork = $true
  Invoke-TestDocker run -d --name $testDatabaseContainer --label $testLabel --network $testNetwork --network-alias ipe-repair-mariadb --tmpfs '/var/lib/mysql:rw,nosuid,nodev,size=768m' --env "MARIADB_ROOT_PASSWORD=$testPassword" --env 'MARIADB_ROOT_HOST=%' --env "MARIADB_DATABASE=$testDatabaseName" mariadb:11.4.10
  $createdDatabase = $true
  # Package installation alone uses the normal isolated-container bridge.
  # No host mounts, production environment or DB connectivity during install.
  Invoke-TestDocker run -d --name $testRunnerContainer --label $testLabel --network bridge --workdir /workspace node:22.11.0-bookworm-slim node -e 'setInterval(() => {}, 1000000)'
  $createdRunner = $true
  Invoke-TestDocker cp "$stagingPath/." "${testRunnerContainer}:/workspace"
  # Node 22.11's bundled Corepack has obsolete registry signing keys. Install
  # the repository-pinned package-manager version, not a signature bypass.
  Invoke-TestDocker exec $testRunnerContainer npm install --global pnpm@10.4.1 --ignore-scripts
  Invoke-TestDocker exec $testRunnerContainer pnpm install --frozen-lockfile --ignore-scripts
  Invoke-TestDocker network disconnect bridge $testRunnerContainer
  Invoke-TestDocker network connect $testNetwork $testRunnerContainer

  $healthy = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker --context $testDockerContext exec $testDatabaseContainer healthcheck.sh --connect --innodb_initialized *> $null
    if ($LASTEXITCODE -eq 0) { $healthy = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $healthy) { throw 'ISOLATED_MARIADB_STARTUP_FAILED' }
  Write-Output "ISOLATED_NETWORK=$testNetwork"
  Write-Output "ISOLATED_DB_CONTAINER=$testDatabaseContainer"
  Write-Output "ISOLATED_RUNNER_CONTAINER=$testRunnerContainer"
  Write-Output "ISOLATED_DATABASE=$testDatabaseName"
  Invoke-TestDocker exec --env "IPE_REPAIR_TEST_DB_URL=mysql://root:${testPassword}@ipe-repair-mariadb:3306/$testDatabaseName" --env IPE_REPAIR_TEST_ALLOW_DOCKER_SERVICE=1 $testRunnerContainer node node_modules/vitest/vitest.mjs run --config vitest.legacy-slip-repair.config.ts
}
finally {
  if (-not $KeepResources) {
    foreach ($entry in @(@($testRunnerContainer, $createdRunner), @($testDatabaseContainer, $createdDatabase))) {
      if ($entry[1]) {
        $label = & docker --context $testDockerContext inspect --format '{{index .Config.Labels "com.ipenovel.isolated-repair"}}' $entry[0]
        if ($LASTEXITCODE -ne 0 -or $label -ne $testSuffix) { throw 'CONTAINER_CLEANUP_OWNERSHIP_NOT_PROVEN' }
        Invoke-TestDocker rm -f $entry[0]
      }
    }
    if ($createdNetwork) {
      $label = & docker --context $testDockerContext network inspect --format '{{index .Labels "com.ipenovel.isolated-repair"}}' $testNetwork
      if ($LASTEXITCODE -ne 0 -or $label -ne $testSuffix) { throw 'NETWORK_CLEANUP_OWNERSHIP_NOT_PROVEN' }
      Invoke-TestDocker network rm $testNetwork
    }
  } else {
    Write-Output "RETAINED_SYNTHETIC_RESOURCES_PREFIX=$testPrefix"
  }
  if (Test-Path -LiteralPath $stagingPath) {
    $resolvedStaging = (Resolve-Path -LiteralPath $stagingPath).Path
    if ($resolvedStaging -ne [IO.Path]::GetFullPath((Join-Path $stagingParent $testPrefix)) -or
        -not $testPrefix.StartsWith('ipe-legacy-repair-') -or
        ((Get-Item -LiteralPath $resolvedStaging).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'STAGING_CLEANUP_TARGET_NOT_PROVEN' }
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
  }
}
