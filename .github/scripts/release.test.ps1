#requires -Version 7.4
# Run with: pwsh -NoProfile -File ./.github/scripts/release.test.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/release.ps1" -LoadOnly

$keys = @('GH_REPO', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_REF', 'RELEASE_VERSION', 'GITHUB_RUN_NUMBER', 'GITHUB_RUN_ID', 'GITHUB_SHA', 'RUNNER_TEMP', 'GITHUB_OUTPUT', 'ARTIFACT_ID', 'ARTIFACT_DIGEST', 'ARTIFACT_NAME')
$saved = @{}
foreach ($key in $keys) { $saved[$key] = [Environment]::GetEnvironmentVariable($key) }
$root = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
$null = New-Item -ItemType Directory -Path $root
try {
    $env:GH_REPO = $env:GITHUB_REPOSITORY = 'notmike101/teams-custom-code-patch'
    $env:GITHUB_EVENT_NAME = 'push'
    $env:GITHUB_REF = 'refs/heads/master'
    $env:RELEASE_VERSION = '1.0.42'
    $env:GITHUB_RUN_NUMBER = '42'
    $env:GITHUB_RUN_ID = '123'
    $env:GITHUB_SHA = 'a' * 40
    $env:RUNNER_TEMP = $root
    $env:GITHUB_OUTPUT = Join-Path $root 'outputs'
    $fixture = Join-Path $root 'fixture'
    $null = New-Item -ItemType Directory -Path $fixture
    $setup = 'TeamsCustom-1.0.42-windows-x64-setup.exe'
    $portable = 'TeamsCustom-1.0.42-windows-x64-portable.zip'
    [IO.File]::WriteAllText((Join-Path $fixture $setup), 'original setup bytes')
    [IO.File]::WriteAllText((Join-Path $fixture $portable), 'original portable bytes')
    $setupHash = (Get-FileHash (Join-Path $fixture $setup)).Hash.ToLowerInvariant()
    $portableHash = (Get-FileHash (Join-Path $fixture $portable)).Hash.ToLowerInvariant()
    $manifest = "$setupHash  $setup`n$portableHash  $portable`n"
    [IO.File]::WriteAllText((Join-Path $fixture 'SHA256SUMS'), $manifest)
    $script:tagSha = $env:GITHUB_SHA
    $script:release = [pscustomobject]@{
        id = 7; tag_name = 'v1.0.42'; draft = $false; prerelease = $false; published_at = '2026-10-06T00:00:00Z'
        body = Get-ReleaseNotes '99' ('sha256:' + ('b' * 64)) $setupHash $portableHash
        assets = @($setup, $portable, 'SHA256SUMS') | ForEach-Object { [pscustomobject]@{ name = $_; state = 'uploaded'; size = 1 } }
    }
    $script:writes = 0
    $script:downloads = 0
    $script:firstPublication = $false
    $script:corruptArchive = $false
    # Fixtures replace only the external GitHub boundary; all trust/hash logic is real.
    function Invoke-GhJson([string[]] $Arguments) {
        if ($Arguments -contains '--method') { $script:writes++; throw 'Unexpected write request.' }
        $endpoint = $Arguments[-1]
        if ($endpoint -like '*/git/matching-refs/*') {
            if ($script:firstPublication) { return @() }
            return @([pscustomobject]@{ ref = 'refs/tags/v1.0.42'; object = @{ type = 'commit'; sha = $script:tagSha } })
        }
        if ($endpoint -like '*/releases?per_page=*') {
            if ($script:firstPublication) { return ,@() }
            return ,@($script:release)
        }
        if ($endpoint -like '*/actions/artifacts/99') { return $script:artifact }
        if ($endpoint -like '*/releases/7') { return $script:release }
        throw "Unexpected read request: $endpoint"
    }
    function Invoke-GhCommand([string[]] $Arguments, [string] $OutputPath) {
        if ($Arguments[0] -ceq 'api' -and $Arguments[1] -like '*/actions/artifacts/99/zip' -and $OutputPath) {
            $script:downloads++
            Copy-Item -LiteralPath $script:fixtureArchivePath -Destination $OutputPath
            if ($script:corruptArchive) { [IO.File]::AppendAllText($OutputPath, 'corrupted download') }
            return
        }
        if ($Arguments[0] -cne 'release' -or $Arguments[1] -cne 'download' -or $OutputPath) { $script:writes++; throw 'Unexpected command mutation.' }
        $script:downloads++
        $destination = $Arguments[([array]::IndexOf($Arguments, '--dir') + 1)]
        $null = New-Item -ItemType Directory -Path $destination
        Copy-Item -Path (Join-Path $fixture '*') -Destination $destination
    }
    function Assert-Rejected([string] $Name, [string] $ExpectedMessage = '') {
        $message = ''
        try { Invoke-AutomaticRelease 'Publish' } catch { $message = $_.Exception.Message }
        if (-not $message -or $script:writes -ne 0 -or ($ExpectedMessage -and $message -cne $ExpectedMessage)) { throw "Guard failed: $Name ($message)" }
    }
    Invoke-AutomaticRelease 'Publish'
    if ($script:writes -ne 0 -or $script:downloads -ne 1 -or
        [IO.File]::ReadAllText($env:GITHUB_OUTPUT) -notmatch 'published=true' -or
        (Get-FileHash (Join-Path $fixture $setup)).Hash.ToLowerInvariant() -cne $setupHash) { throw 'Published rerun did not preserve bytes/skip mutations.' }
    $script:tagSha = 'c' * 40
    Assert-Rejected 'foreign tag SHA'
    $script:tagSha = $env:GITHUB_SHA
    $script:release.draft = $true
    Assert-Rejected 'partial draft'
    $script:release.draft = $false
    $allAssets = $script:release.assets
    $script:release.assets = $allAssets[0..1]
    Assert-Rejected 'incomplete assets'
    $script:release.assets = $allAssets
    [IO.File]::WriteAllText((Join-Path $fixture $setup), 'altered setup bytes')
    Assert-Rejected 'altered asset bytes'
    [IO.File]::WriteAllText((Join-Path $fixture $setup), 'original setup bytes')
    $script:release.body = $script:release.body.Replace('/actions/runs/123', '/actions/runs/999')
    Assert-Rejected 'foreign run provenance'
    $script:release.body = Get-ReleaseNotes '99' ('sha256:' + ('b' * 64)) $setupHash $portableHash
    [IO.File]::WriteAllText((Join-Path $fixture 'SHA256SUMS'), $manifest.Replace("`n", "`r`n"))
    Assert-Rejected 'noncanonical manifest'
    [IO.File]::WriteAllText((Join-Path $fixture 'SHA256SUMS'), $manifest)
    $script:fixtureArchivePath = Join-Path $root 'candidate.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($fixture, $script:fixtureArchivePath)
    $env:ARTIFACT_ID = '99'
    $env:ARTIFACT_NAME = 'teams-custom-windows-x64-1'
    $env:ARTIFACT_DIGEST = 'sha256:' + (Get-FileHash -LiteralPath $script:fixtureArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $script:artifact = [pscustomobject]@{
        id = 99; expired = $false; name = $env:ARTIFACT_NAME; digest = $env:ARTIFACT_DIGEST
        workflow_run = [pscustomobject]@{ id = 999; head_sha = $env:GITHUB_SHA }
    }
    $script:firstPublication = $true
    $beforeDownload = $script:downloads
    Assert-Rejected 'foreign artifact run' 'Artifact does not belong to this exact build run/attempt.'
    if ($script:downloads -ne $beforeDownload) { throw 'Foreign artifact was downloaded.' }
    $script:artifact.workflow_run.id = 123
    $script:corruptArchive = $true
    Assert-Rejected 'corrupt archive digest' 'Downloaded artifact archive digest differs from the uploaded artifact.'
    if ($script:downloads -ne ($beforeDownload + 1)) { throw 'Archive digest rejection did not exercise downloaded bytes.' }
    Write-Host 'Release guard checks passed: published rerun, tag/draft/assets/provenance/manifest, foreign artifact run and corrupt archive; zero writes.'
} finally {
    foreach ($key in $keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
    Remove-Item -LiteralPath $root -Recurse -Force
}
