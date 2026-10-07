#requires -Version 7.4
[CmdletBinding()]
param(
    [ValidateSet('Check', 'Publish')] [string] $Mode = 'Check',
    [switch] $LoadOnly
)

$ErrorActionPreference = 'Stop'

function Invoke-GhJson([string[]] $Arguments) {
    $json = & gh @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'GitHub API request failed; nothing will be replaced.' }
    return ($json -join "`n" | ConvertFrom-Json)
}

function Invoke-GhCommand([string[]] $Arguments, [string] $OutputPath) {
    if ($OutputPath) { & gh @Arguments > $OutputPath } else { & gh @Arguments | Out-Host }
    if ($LASTEXITCODE -ne 0) { throw 'GitHub command failed; inspect for a partial draft before rerunning.' }
}

function Get-ReleaseNotes([string] $ArtifactId, [string] $ArtifactDigest, [string] $SetupHash, [string] $PortableHash) {
    return (@(
        'Automatically published after CI lint, Node tests, Windows packaging and exact artifact/hash checks.',
        'Unsigned Windows x64 binaries; no automatic updates. CI does not prove live Teams behavior, a clean VM/account, or universal compatibility.',
        "Source commit: https://github.com/$env:GH_REPO/commit/$env:GITHUB_SHA",
        "Build run: https://github.com/$env:GH_REPO/actions/runs/$env:GITHUB_RUN_ID",
        "Candidate artifact ID: $ArtifactId; SHA256: $ArtifactDigest",
        "Setup SHA256: $SetupHash",
        "Portable SHA256: $PortableHash"
    ) -join "`n")
}

function Assert-ReleaseFiles([string] $Directory) {
    $setup = "TeamsCustom-$env:RELEASE_VERSION-windows-x64-setup.exe"
    $portable = "TeamsCustom-$env:RELEASE_VERSION-windows-x64-portable.zip"
    $expected = @($setup, $portable, 'SHA256SUMS')
    $entries = @(Get-ChildItem -LiteralPath $Directory -Force)
    if ($entries.Count -ne 3) { throw 'Assets must contain exactly setup, portable and SHA256SUMS.' }
    foreach ($entry in $entries) {
        if ($entry.PSIsContainer -or $entry.Name -cnotin $expected -or
            ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected asset entry.' }
    }
    $setupHash = (Get-FileHash -LiteralPath (Join-Path $Directory $setup) -Algorithm SHA256).Hash.ToLowerInvariant()
    $portableHash = (Get-FileHash -LiteralPath (Join-Path $Directory $portable) -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifest = [IO.File]::ReadAllText((Join-Path $Directory 'SHA256SUMS'))
    if ($manifest -cne "$setupHash  $setup`n$portableHash  $portable`n") { throw 'SHA256SUMS must be the canonical two-line manifest of the actual files.' }
    return @{ Setup = $setup; Portable = $portable; SetupHash = $setupHash; PortableHash = $portableHash }
}

function Get-ReleaseState {
    $tag = "v$env:RELEASE_VERSION"
    $refs = @(Invoke-GhJson @('api', "repos/$env:GH_REPO/git/matching-refs/tags/$tag") | Where-Object { $_.ref -ceq "refs/tags/$tag" })
    if ($refs.Count -gt 1 -or ($refs.Count -eq 1 -and
        ($refs[0].object.type -cne 'commit' -or $refs[0].object.sha -cne $env:GITHUB_SHA))) { throw 'Existing tag is not the exact automated source commit.' }
    # Authenticated listing includes drafts; a tags endpoint 404 does not prove absence.
    $pages = Invoke-GhJson @('api', '--paginate', '--slurp', "repos/$env:GH_REPO/releases?per_page=100")
    $releases = @($pages | ForEach-Object { $_ } | Where-Object { $_.tag_name -ceq $tag })
    if ($releases.Count -gt 1) { throw 'Multiple releases for this tag.' }
    if ($releases.Count -eq 0) { return @{ Published = $false; TagExists = ($refs.Count -eq 1) } }
    $release = Invoke-GhJson @('api', "repos/$env:GH_REPO/releases/$($releases[0].id)")
    if ($release.draft -ne $false -or $release.prerelease -ne $false -or -not $release.published_at -or
        $release.tag_name -cne $tag -or $refs.Count -ne 1) { throw 'Existing draft, incomplete release or inconsistent tag; nothing will be replaced.' }
    $expected = @("TeamsCustom-$env:RELEASE_VERSION-windows-x64-setup.exe", "TeamsCustom-$env:RELEASE_VERSION-windows-x64-portable.zip", 'SHA256SUMS')
    $assets = @($release.assets)
    if ($assets.Count -ne 3 -or @($assets.name | Sort-Object -Unique).Count -ne 3) { throw 'Existing release has an incomplete or duplicate asset set.' }
    foreach ($asset in $assets) {
        if ($asset.name -cnotin $expected -or $asset.state -cne 'uploaded' -or $asset.size -le 0) { throw 'Existing release has unexpected or incomplete assets.' }
    }
    $directory = Join-Path $env:RUNNER_TEMP ([guid]::NewGuid().ToString())
    Invoke-GhCommand @('release', 'download', $tag, '--repo', $env:GH_REPO, '--dir', $directory) ''
    $hashes = Assert-ReleaseFiles $directory
    $provenance = [regex]::Match($release.body, '(?m)^Candidate artifact ID: ([1-9][0-9]*); SHA256: (sha256:[0-9a-f]{64})$')
    if (-not $provenance.Success -or $release.body -cne (Get-ReleaseNotes $provenance.Groups[1].Value $provenance.Groups[2].Value $hashes.SetupHash $hashes.PortableHash)) {
        throw 'Existing release provenance or bytes do not match this source/run.'
    }
    return @{ Published = $true; TagExists = $true }
}

function Invoke-AutomaticRelease([string] $Operation) {
    if ($env:GH_REPO -cne 'notmike101/teams-custom-code-patch' -or $env:GITHUB_REPOSITORY -cne $env:GH_REPO -or
        $env:GITHUB_EVENT_NAME -cne 'push' -or $env:GITHUB_REF -cne 'refs/heads/master') { throw 'Only source-repository master pushes may release.' }
    if ($env:RELEASE_VERSION -cnotmatch '\A(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.([1-9][0-9]{0,4})\z' -or
        @($env:RELEASE_VERSION.Split('.') | Where-Object { [int] $_ -gt 65535 }).Count -gt 0 -or
        $env:RELEASE_VERSION.Split('.')[2] -cne $env:GITHUB_RUN_NUMBER -or
        $env:GITHUB_RUN_ID -cnotmatch '\A[1-9][0-9]*\z' -or $env:GITHUB_SHA -cnotmatch '\A[0-9a-f]{40}\z') { throw 'Invalid version/run/source identity.' }
    $state = Get-ReleaseState
    if ($state.Published) {
        if ($env:GITHUB_OUTPUT) { 'published=true' >> $env:GITHUB_OUTPUT }
        Write-Host 'Exact published release verified; preserving original bytes and skipping build/publication.'
        return
    }
    if ($env:GITHUB_OUTPUT) { 'published=false' >> $env:GITHUB_OUTPUT }
    if ($Operation -ceq 'Check') { return }
    if ($Operation -cne 'Publish' -or $env:ARTIFACT_ID -cnotmatch '\A[1-9][0-9]*\z' -or
        $env:ARTIFACT_DIGEST -cnotmatch '\Asha256:[0-9a-f]{64}\z' -or
        $env:ARTIFACT_NAME -cnotmatch '\Ateams-custom-windows-x64-[1-9][0-9]*\z') { throw 'Invalid artifact identity.' }
    $artifact = Invoke-GhJson @('api', "repos/$env:GH_REPO/actions/artifacts/$env:ARTIFACT_ID")
    if ([string] $artifact.id -cne $env:ARTIFACT_ID -or $artifact.expired -ne $false -or
        $artifact.name -cne $env:ARTIFACT_NAME -or
        [string] $artifact.workflow_run.id -cne $env:GITHUB_RUN_ID -or
        $artifact.workflow_run.head_sha -cne $env:GITHUB_SHA -or $artifact.digest -cne $env:ARTIFACT_DIGEST) { throw 'Artifact does not belong to this exact build run/attempt.' }
    $archive = Join-Path $env:RUNNER_TEMP "$([guid]::NewGuid()).zip"
    Invoke-GhCommand @('api', "repos/$env:GH_REPO/actions/artifacts/$env:ARTIFACT_ID/zip") $archive
    if ('sha256:' + (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $env:ARTIFACT_DIGEST) { throw 'Downloaded artifact archive digest differs from the uploaded artifact.' }
    $directory = Join-Path $env:RUNNER_TEMP ([guid]::NewGuid().ToString())
    $null = New-Item -ItemType Directory -Path $directory
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $expected = @("TeamsCustom-$env:RELEASE_VERSION-windows-x64-setup.exe", "TeamsCustom-$env:RELEASE_VERSION-windows-x64-portable.zip", 'SHA256SUMS')
        if ($zip.Entries.Count -ne 3 -or @($zip.Entries.FullName | Sort-Object -Unique).Count -ne 3) { throw 'Artifact archive must contain exactly three distinct files.' }
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -cnotin $expected) { throw 'Unexpected archive path.' }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $directory $entry.FullName))
        }
    } finally { $zip.Dispose() }
    $hashes = Assert-ReleaseFiles $directory
    $notes = Get-ReleaseNotes $env:ARTIFACT_ID $env:ARTIFACT_DIGEST $hashes.SetupHash $hashes.PortableHash
    # Recheck after download before any mutation; never move tags or replace draft/public assets.
    $state = Get-ReleaseState
    if ($state.Published) { return }
    $tag = "v$env:RELEASE_VERSION"
    if (-not $state.TagExists) {
        $null = Invoke-GhJson @('api', '--method', 'POST', "repos/$env:GH_REPO/git/refs", '-f', "ref=refs/tags/$tag", '-f', "sha=$env:GITHUB_SHA")
    }
    $state = Get-ReleaseState
    if ($state.Published) { return }
    $release = Invoke-GhJson @('api', '--method', 'POST', "repos/$env:GH_REPO/releases", '-f', "tag_name=$tag", '-f', "name=Teams Custom $tag", '-f', "body=$notes", '-F', 'draft=true', '-F', 'prerelease=false')
    if ($release.draft -ne $true -or $release.tag_name -cne $tag) { throw 'Unexpected draft response; inspect GitHub before rerunning.' }
    Invoke-GhCommand @('release', 'upload', $tag, (Join-Path $directory $hashes.Setup), (Join-Path $directory $hashes.Portable), (Join-Path $directory 'SHA256SUMS'), '--repo', $env:GH_REPO) ''
    $uploaded = Invoke-GhJson @('api', "repos/$env:GH_REPO/releases/$($release.id)")
    if ($uploaded.draft -ne $true -or $uploaded.body -cne $notes -or $uploaded.tag_name -cne $tag -or @($uploaded.assets).Count -ne 3) { throw 'Draft changed or upload is incomplete; nothing will be replaced.' }
    foreach ($name in @($hashes.Setup, $hashes.Portable, 'SHA256SUMS')) {
        $assets = @($uploaded.assets | Where-Object { $_.name -ceq $name })
        $path = Join-Path $directory $name
        $digest = 'sha256:' + (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($assets.Count -ne 1 -or $assets[0].state -cne 'uploaded' -or $assets[0].size -ne (Get-Item -LiteralPath $path).Length -or
            $assets[0].digest -cne $digest) { throw 'Uploaded draft assets do not match the exact verified files.' }
    }
    $refs = @(Invoke-GhJson @('api', "repos/$env:GH_REPO/git/matching-refs/tags/$tag") | Where-Object { $_.ref -ceq "refs/tags/$tag" })
    if ($refs.Count -ne 1 -or $refs[0].object.type -cne 'commit' -or $refs[0].object.sha -cne $env:GITHUB_SHA) { throw 'Tag changed before publication.' }
    $published = Invoke-GhJson @('api', '--method', 'PATCH', "repos/$env:GH_REPO/releases/$($release.id)", '-F', 'draft=false', '-f', 'make_latest=legacy')
    if ($published.draft -ne $false -or $published.tag_name -cne $tag) { throw 'Unexpected publication response; inspect GitHub before rerunning.' }
}

if (-not $LoadOnly) { Invoke-AutomaticRelease $Mode }
