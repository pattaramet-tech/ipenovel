# No real Docker calls or resource writes. Run with both powershell.exe and pwsh.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib/legacySlipRepairDockerOwnership.ps1')
$testSuffix = '012345abcdef'
$passed = 0

function docker {
  $script:observedArguments = @($args)
  $global:LASTEXITCODE = $script:mockExitCode
  if ($script:mockThrows) { throw 'PRIVATE_INSPECT_DIAGNOSTIC' }
  $script:mockOutput
}

foreach ($kind in @('container', 'network')) {
  $name = if ($kind -eq 'container') { "ipe-legacy-repair-$testSuffix-node" } else { "ipe-legacy-repair-$testSuffix-net" }
  $resourceName = if ($kind -eq 'container') { "/$name" } else { $name }
  $valid = if ($kind -eq 'container') {
    @{ Name = $resourceName; Config = @{ Labels = @{ 'com.ipenovel.isolated-repair' = $testSuffix } } }
  } else {
    @{ Name = $resourceName; Labels = @{ 'com.ipenovel.isolated-repair' = $testSuffix } }
  }
  $validJson = ConvertTo-Json -InputObject @($valid) -Depth 5
  foreach ($case in @('valid', 'wrong-label', 'missing-label', 'wrong-name', 'wrong-case-name', 'empty', 'multiple', 'object-not-array', 'malformed', 'nonzero-exit', 'docker-throws', 'invalid-target', 'invalid-suffix')) {
    $script:mockOutput = $validJson -split "`n"
    $script:mockExitCode = 0
    $script:mockThrows = $false
    $script:observedArguments = @()
    $targetName = $name
    $suffix = $testSuffix
    switch ($case) {
      'wrong-label' { $script:mockOutput = $validJson.Replace(":  `"$testSuffix`"", ':  "ffffffffffff"').Replace(": `"$testSuffix`"", ': "ffffffffffff"') }
      'missing-label' { $script:mockOutput = $validJson.Replace('com.ipenovel.isolated-repair', 'different-label') }
      'wrong-name' { $script:mockOutput = $validJson.Replace($resourceName, "$resourceName-other") }
      'wrong-case-name' { $script:mockOutput = $validJson.Replace($resourceName, $resourceName.ToUpperInvariant()) }
      'empty' { $script:mockOutput = '[]' }
      'multiple' { $script:mockOutput = ConvertTo-Json -InputObject @($valid, $valid) -Depth 5 }
      'object-not-array' { $script:mockOutput = ConvertTo-Json -InputObject $valid -Depth 5 }
      'malformed' { $script:mockOutput = '[PRIVATE_INVALID_JSON' }
      'nonzero-exit' { $script:mockExitCode = 64 }
      'docker-throws' { $script:mockThrows = $true }
      'invalid-target' { $targetName = 'unrelated-user-container' }
      'invalid-suffix' { $suffix = '*' }
    }
    $caught = $null
    try {
      Assert-LegacyRepairDockerOwnership -Context desktop-linux -Kind $kind -Name $targetName -Suffix $suffix
    } catch { $caught = $_.Exception.Message }
    $expectedFailure = "$($kind.ToUpperInvariant())_CLEANUP_OWNERSHIP_NOT_PROVEN"
    if (($case -eq 'valid' -and $null -ne $caught) -or
        ($case -ne 'valid' -and $caught -cne $expectedFailure)) { throw "FAILED: $kind/$case" }
    if ($case -in @('invalid-target', 'invalid-suffix')) {
      if ($script:observedArguments.Count -ne 0) { throw 'INVALID_TARGET_REACHED_DOCKER' }
    } elseif (($script:observedArguments -join '|') -cne "--context|desktop-linux|$kind|inspect|$name") {
      throw 'UNEXPECTED_DOCKER_ARGUMENTS'
    }
    $passed++
  }
}
Write-Output "CLEANUP_OWNERSHIP_TESTS_PASSED=$passed POWERSHELL=$($PSVersionTable.PSVersion)"
