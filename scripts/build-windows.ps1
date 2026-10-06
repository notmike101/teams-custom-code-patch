#requires -Version 7.0
[CmdletBinding()]
param(
    [string] $InnoCompiler,
    [switch] $ProvisionInno
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Windows x64 and PowerShell 7 or later are required.' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'A 64-bit Windows host is required.' }

$root = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $root '.tools'
$work = Join-Path $root 'build/windows-distribution'
$dist = Join-Path $root 'dist'
$owner = 'TeamsCustom Windows distribution build v1'
$nodeVersion = '24.21.0'
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchiveHash = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$nodeExeHash = 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32'
$innoVersion = '7.1.0'
$innoInstallerHash = '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f'

# Never traverse a junction/symlink when writing or removing generated files.
function Assert-PlainPath([string] $Path) {
    $current = [IO.Path]::GetFullPath($Path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Refusing reparse-point path: $current"
            }
        }
        $current = Split-Path $current -Parent
    }
}

function Assert-Hash([string] $Path, [string] $Expected) {
    Assert-PlainPath $Path
    if ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -ne $Expected) {
        throw "SHA256 mismatch: $Path. Remove this cache file explicitly before retrying."
    }
}

function Get-PinnedDownload([string] $Url, [string] $Path, [string] $Hash) {
    Assert-PlainPath $Path
    if (-not (Test-Path -LiteralPath $Path)) {
        $partial = "$Path.download"
        Assert-PlainPath $partial
        if (Test-Path -LiteralPath $partial) { throw "Remove the existing partial download explicitly: $partial" }
        try {
            Invoke-WebRequest -Uri $Url -OutFile $partial
            Assert-Hash $partial $Hash
            Move-Item -LiteralPath $partial -Destination $Path
        } finally {
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial }
        }
    }
    Assert-Hash $Path $Hash
}

function Write-Json([string] $Path, $Value) {
    $Value | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding utf8NoBOM
}

$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json -AsHashtable
$lock = Get-Content -LiteralPath (Join-Path $root 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
$version = [string] $package.version
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or
    @($version.Split('.') | Where-Object { [decimal] $_ -gt 65535 }).Count -gt 0) {
    throw 'package.json version must be three numeric components from 0 to 65535 (no prerelease or directive text).'
}
if ($lock.lockfileVersion -ne 3 -or $lock.packages[''].version -ne $version -or
    $lock.packages[''].name -ne $package.name) { throw 'package.json and lockfile metadata must agree.' }
if ($package.dependencies.Count -ne 1 -or -not $package.dependencies.ContainsKey('ws')) {
    throw 'This payload supports the existing single production dependency, ws. Review staging before changing dependencies.'
}
$ws = $lock.packages['node_modules/ws']
if (-not $ws -or $ws.ContainsKey('dependencies') -or $ws.ContainsKey('dev') -or
    $ws.version -notmatch '^\d+\.\d+\.\d+$' -or
    $ws.resolved -ne "https://registry.npmjs.org/ws/-/ws-$($ws.version).tgz" -or
    $ws.integrity -notmatch '^sha512-[A-Za-z0-9+/]+={0,2}$') {
    throw 'Expected a locked, integrity-pinned production ws package without runtime dependencies.'
}

foreach ($path in @($tools, $work, $dist)) { Assert-PlainPath $path }
New-Item -ItemType Directory -Path $tools, $dist -Force | Out-Null

if ($ProvisionInno -and $InnoCompiler) { throw 'Use either -InnoCompiler or -ProvisionInno, not both.' }
if (-not $InnoCompiler) { $InnoCompiler = Join-Path $tools 'inno/ISCC.exe' }
$InnoCompiler = [IO.Path]::GetFullPath($InnoCompiler)
Assert-PlainPath $InnoCompiler
if ($ProvisionInno -and -not (Test-Path -LiteralPath $InnoCompiler)) {
    $installer = Join-Path $tools "innosetup-$innoVersion-x64.exe"
    Get-PinnedDownload "https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-$innoVersion-x64.exe" $installer $innoInstallerHash
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)CN=Pyrsys B\.V\.(,|$)') {
        throw 'The Inno installer must have a valid Pyrsys B.V. Authenticode signature.'
    }
    $license = Join-Path $tools "innosetup-$innoVersion-LICENSE.txt"
    Assert-PlainPath $license
    Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/jrsoftware/issrc/is-7_1_0/license.txt' -OutFile $license
    if ((Get-Item -LiteralPath $license).Length -eq 0) { throw 'The upstream Inno license was empty.' }
    $innoDirectory = Split-Path $InnoCompiler -Parent
    Assert-PlainPath $innoDirectory
    # Explicit switch authorizes only this pinned current-user compiler installation.
    $process = Start-Process -FilePath $installer -ArgumentList @('/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$innoDirectory`"") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Inno provisioning failed with exit code $($process.ExitCode)." }
}
if (-not (Test-Path -LiteralPath $InnoCompiler -PathType Leaf)) {
    throw 'Inno Setup 7.1.0 is required. Supply -InnoCompiler or explicitly select -ProvisionInno (retains upstream license).'
}
$compilerVersion = & $InnoCompiler --version
if ($LASTEXITCODE -ne 0 -or $compilerVersion -isnot [string] -or $compilerVersion -cne $innoVersion) {
    throw 'The Inno compiler must report version 7.1.0 successfully through --version.'
}
$csc = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw 'The native .NET Framework x64 C# compiler is required.' }

# Only this marked build subdirectory belongs to this script; never clean build/dist/.tools wholesale.
$marker = Join-Path $work '.teamscustom-build-owner'
if (Test-Path -LiteralPath $work) {
    foreach ($item in Get-ChildItem -LiteralPath $work -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked build output: $($item.FullName)" }
    }
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
        (Get-Content -LiteralPath $marker -Raw).Trim() -ne $owner) {
        throw "Refusing to clean an unowned build directory: $work"
    }
    Remove-Item -LiteralPath $work -Recurse -Force
}
New-Item -ItemType Directory -Path $work | Out-Null
Set-Content -LiteralPath $marker -Value $owner -Encoding utf8NoBOM
$payload = Join-Path $work 'payload'
$runtime = Join-Path $payload 'runtime'
$app = Join-Path $payload 'app'
$licenses = Join-Path $payload 'licenses'
$dependencies = Join-Path $work 'dependencies'
New-Item -ItemType Directory -Path $runtime, $app, $licenses, $dependencies | Out-Null

$nodeArchive = Join-Path $tools $nodeArchiveName
Get-PinnedDownload "https://nodejs.org/dist/v$nodeVersion/$nodeArchiveName" $nodeArchive $nodeArchiveHash
# Extract verified archive afresh: an existing extracted cache is never executed or copied.
Expand-Archive -LiteralPath $nodeArchive -DestinationPath (Join-Path $work 'node')
$nodeRoot = Join-Path $work "node/node-v$nodeVersion-win-x64"
$node = Join-Path $nodeRoot 'node.exe'
Assert-Hash $node $nodeExeHash
Copy-Item -LiteralPath $node -Destination (Join-Path $runtime 'node.exe')
Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination (Join-Path $licenses 'Node-LICENSE.txt')

# Use a production-only lock subset, not the developer install or its vendored ESLint archives.
$appPackage = [ordered]@{
    name = $package.name
    version = $version
    description = $package.description
    type = 'module'
    license = $package.license
    engines = $package.engines
    dependencies = @{ ws = $ws.version }
}
Write-Json (Join-Path $dependencies 'package.json') $appPackage
$productionLock = [ordered]@{
    name = $package.name
    version = $version
    lockfileVersion = 3
    requires = $true
    packages = @{ '' = $appPackage; 'node_modules/ws' = $ws }
}
Write-Json (Join-Path $dependencies 'package-lock.json') $productionLock
$npm = Join-Path $nodeRoot 'node_modules/npm/bin/npm-cli.js'
& $node $npm --prefix $dependencies ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --cache (Join-Path $work 'npm-cache')
if ($LASTEXITCODE -ne 0) { throw "Production npm ci failed with exit code $LASTEXITCODE." }
$installedPackages = @(Get-ChildItem -LiteralPath (Join-Path $dependencies 'node_modules') -Directory -Force)
if ($installedPackages.Count -ne 1 -or $installedPackages[0].Name -ne 'ws') { throw 'Unexpected production package: expected only ws.' }
New-Item -ItemType Directory -Path (Join-Path $app 'node_modules') | Out-Null
Copy-Item -LiteralPath (Join-Path $dependencies 'node_modules/ws') -Destination (Join-Path $app 'node_modules/ws') -Recurse
Copy-Item -LiteralPath (Join-Path $app 'node_modules/ws/LICENSE') -Destination (Join-Path $licenses 'ws-LICENSE.txt')
Write-Json (Join-Path $app 'package.json') $appPackage
Copy-Item -LiteralPath (Join-Path $root 'index.js') -Destination (Join-Path $app 'index.js')
foreach ($directory in @('lib', 'inject')) {
    $source = Join-Path $root $directory
    Assert-PlainPath $source
    foreach ($item in Get-ChildItem -LiteralPath $source -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked app source: $($item.FullName)" }
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $app $directory) -Recurse
}

$exe = Join-Path $payload 'TeamsCustom.exe'
& $csc /nologo /target:winexe /platform:x64 /optimize+ "/out:$exe" "/win32manifest:$(Join-Path $root 'launcher/TeamsCustom.manifest')" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll (Join-Path $root 'launcher/TeamsCustom.cs')
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed with exit code $LASTEXITCODE." }
Copy-Item -LiteralPath (Join-Path $root 'launcher/TeamsCustom.exe.config') -Destination (Join-Path $payload 'TeamsCustom.exe.config')

$assetBase = "TeamsCustom-$version-windows-x64"
$setupName = "$assetBase-setup.exe"
$zipName = "$assetBase-portable.zip"
# Replace only these exact generated filenames; unrelated dist files and other versions survive.
foreach ($name in @($setupName, $zipName, 'SHA256SUMS')) {
    $path = Join-Path $dist $name
    Assert-PlainPath $path
    if (Test-Path -LiteralPath $path) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Output filename is a directory: $path" }
        Remove-Item -LiteralPath $path
    }
}
& $InnoCompiler "/DAppVersion=$version" "/DPayloadDir=$payload" "/DOutputDir=$dist" "/DOutputBaseName=$assetBase-setup" (Join-Path $root 'installer/TeamsCustom.iss')
if ($LASTEXITCODE -ne 0) { throw "Installer compilation failed with exit code $LASTEXITCODE." }
Compress-Archive -Path (Join-Path $payload '*') -DestinationPath (Join-Path $dist $zipName) -CompressionLevel Optimal
$checksumLines = foreach ($name in @($setupName, $zipName)) {
    $hash = (Get-FileHash -LiteralPath (Join-Path $dist $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $name"
}
[IO.File]::WriteAllText((Join-Path $dist 'SHA256SUMS'), ($checksumLines -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
Write-Host "Payload: $payload"
Write-Host "Assets: $dist/$setupName, $dist/$zipName, $dist/SHA256SUMS"
Write-Host 'Unsigned distribution. Runtime upgrades require the real Windows managed-pipe regression checks before release.'
