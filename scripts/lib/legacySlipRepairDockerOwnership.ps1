# Function-only helper: dot-sourcing never inspects or removes Docker resources.
function Assert-LegacyRepairDockerOwnership {
  param(
    [Parameter(Mandatory = $true)][string]$Context,
    [Parameter(Mandatory = $true)][ValidateSet('container', 'network')][string]$Kind,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Suffix
  )

  $failure = "$($Kind.ToUpperInvariant())_CLEANUP_OWNERSHIP_NOT_PROVEN"
  if ($Suffix -cnotmatch '^[a-f0-9]{12}$' -or
      ($Kind -eq 'container' -and $Name -cnotin @("ipe-legacy-repair-$Suffix-node", "ipe-legacy-repair-$Suffix-db")) -or
      ($Kind -eq 'network' -and $Name -cne "ipe-legacy-repair-$Suffix-net")) { throw $failure }

  try {
    # Full JSON avoids native Go-template quoting differences in Windows PS 5.1.
    # Never print inspect output: container configuration can contain credentials.
    $inspectOutput = & docker --context $Context $Kind inspect $Name
    $inspectExitCode = $LASTEXITCODE
    if ($inspectExitCode -ne 0) { throw $failure }
    $inspectJson = $inspectOutput -join "`n"
    if (-not $inspectJson.TrimStart().StartsWith('[')) { throw $failure }
    $resources = @(ConvertFrom-Json -InputObject $inspectJson -ErrorAction Stop)
    if ($resources.Count -ne 1) { throw $failure }
    $resource = $resources[0]
    if ($Kind -eq 'container') {
      $expectedName = "/$Name"
      $labels = $resource.Config.Labels
    } else {
      $expectedName = $Name
      $labels = $resource.Labels
    }
    if ($resource.Name -isnot [string] -or $resource.Name -cne $expectedName -or
        $labels.'com.ipenovel.isolated-repair' -isnot [string] -or
        $labels.'com.ipenovel.isolated-repair' -cne $Suffix) { throw $failure }
  } catch {
    throw $failure
  }
}
