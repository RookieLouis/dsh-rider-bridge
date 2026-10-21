#requires -Version 5.1
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$CompanionPath = '',
    [string]$DshHome = '',
    [string]$BackupRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pluginName = 'dsh-rider-bridge'
$legacyPluginName = 'dsh-ide-bridge'
if ([string]::IsNullOrWhiteSpace($CompanionPath)) {
    $CompanionPath = Join-Path $PSScriptRoot '..'
}
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
$dshHomePath = [IO.Path]::GetFullPath($DshHome)
$profilesDirectory = Join-Path $dshHomePath 'profiles'
$profilePath = Join-Path $profilesDirectory 'desktop'
$companionRoot = [IO.Path]::GetFullPath($CompanionPath)
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    $BackupRoot = Join-Path $dshHomePath 'backups\dsh-rider-bridge-install'
}
$backupRootPath = [IO.Path]::GetFullPath($BackupRoot)
$packagePath = Join-Path $profilePath 'package.json'
$utf8 = New-Object Text.UTF8Encoding($false)

function Test-WithinDirectory {
    param([string]$Path, [string]$Directory)
    return [string]::Equals($Path, $Directory, [StringComparison]::OrdinalIgnoreCase) -or
        $Path.StartsWith($Directory.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-PhysicalPath {
    param([string]$Path, [int]$Depth = 0)
    if ($Depth -gt 24) { throw "Too many symbolic links while resolving: $Path" }
    $absolute = [IO.Path]::GetFullPath($Path)
    $volume = [IO.Path]::GetPathRoot($absolute)
    $parts = $absolute.Substring($volume.Length).Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)
    $resolved = $volume
    foreach ($part in $parts) {
        $resolved = Join-Path $resolved $part
        $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            $targetProperty = $item.PSObject.Properties['Target']
            $linkTargets = @(if ($null -ne $targetProperty) { $targetProperty.Value })
            if ($linkTargets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$linkTargets[0])) {
                throw "Cannot safely resolve this symbolic link or junction: $resolved"
            }
            $target = [string]$linkTargets[0]
            if ($target.StartsWith('\??\')) { $target = $target.Substring(4) }
            if (-not [IO.Path]::IsPathRooted($target)) {
                $target = Join-Path (Split-Path -Parent $resolved) $target
            }
            $resolved = Resolve-PhysicalPath -Path $target -Depth ($Depth + 1)
        }
    }
    return [IO.Path]::GetFullPath($resolved)
}

function Get-FileLinkMetadata {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    $linkType = $item.PSObject.Properties['LinkType']
    $target = $item.PSObject.Properties['Target']
    return [ordered]@{
        isReparsePoint = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
        linkType = if ($null -ne $linkType) { [string]$linkType.Value } else { $null }
        linkTargets = if ($null -ne $target) { @($target.Value) } else { @() }
    }
}

function Resolve-PlannedPath {
    param([string]$Path)
    $absolute = [IO.Path]::GetFullPath($Path)
    $existing = $absolute
    $suffix = @()
    while ($null -eq (Get-Item -LiteralPath $existing -Force -ErrorAction SilentlyContinue)) {
        $suffix = @((Split-Path -Leaf $existing)) + $suffix
        $parent = Split-Path -Parent $existing
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $existing) {
            throw "Cannot resolve a safe existing parent for: $Path"
        }
        $existing = $parent
    }
    $resolved = Resolve-PhysicalPath -Path $existing
    foreach ($part in $suffix) { $resolved = Join-Path $resolved $part }
    return $resolved
}

function Convert-BridgeBundleList {
    param([object[]]$Bundles, [string]$LegacyName, [string]$CurrentName)
    $inserted = $false
    foreach ($bundle in $Bundles) {
        if ($bundle -eq $LegacyName -or $bundle -eq $CurrentName) {
            if (-not $inserted) {
                $CurrentName
                $inserted = $true
            }
        }
        else { $bundle }
    }
    if (-not $inserted) { $CurrentName }
}

function Convert-BridgeManifest {
    param([object]$Manifest, [string]$LegacyName, [string]$CurrentName, [string]$DependencyValue)
    foreach ($sectionName in @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')) {
        $sectionProperty = $Manifest.PSObject.Properties[$sectionName]
        if ($null -ne $sectionProperty -and $null -ne $sectionProperty.Value.PSObject.Properties[$LegacyName]) {
            $sectionProperty.Value.PSObject.Properties.Remove($LegacyName)
        }
    }
    if ($null -eq $Manifest.PSObject.Properties['dependencies']) {
        $Manifest | Add-Member -MemberType NoteProperty -Name 'dependencies' -Value ([pscustomobject]@{})
    }
    if ($null -eq $Manifest.dependencies.PSObject.Properties[$CurrentName]) {
        $Manifest.dependencies | Add-Member -MemberType NoteProperty -Name $CurrentName -Value $DependencyValue
    }
    else { $Manifest.dependencies.PSObject.Properties[$CurrentName].Value = $DependencyValue }
    $Manifest.dsh.profile.bundles = @(Convert-BridgeBundleList -Bundles @($Manifest.dsh.profile.bundles) -LegacyName $LegacyName -CurrentName $CurrentName)
    return $Manifest
}

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "DSH desktop profile is missing: $packagePath"
}
$physicalHome = Resolve-PhysicalPath -Path $dshHomePath
$physicalProfilesDirectory = Resolve-PhysicalPath -Path $profilesDirectory
$physicalProfile = Resolve-PhysicalPath -Path $profilePath
if (-not (Test-WithinDirectory -Path $physicalProfilesDirectory -Directory $physicalHome) -or
    -not (Test-WithinDirectory -Path $physicalProfile -Directory $physicalProfilesDirectory)) {
    throw 'The desktop profile resolves outside the selected DSH home/profiles directory. No files were changed.'
}
$package = [IO.File]::ReadAllText($packagePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($package.name -ne 'dsh-profile-desktop' -or $null -eq $package.PSObject.Properties['dsh'] -or
    $null -eq $package.dsh.PSObject.Properties['profile'] -or
    $null -eq $package.dsh.profile.PSObject.Properties['bundles']) {
    throw 'The selected directory is not the DSH desktop profile with a bundle list.'
}

$companionManifestPath = Join-Path $companionRoot 'package.json'
if (-not (Test-Path -LiteralPath $companionManifestPath -PathType Leaf)) {
    throw "The companion package is missing: $companionManifestPath"
}
$companion = [IO.File]::ReadAllText($companionManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($companion.name -ne $pluginName) { throw "Expected companion package '$pluginName'." }
$physicalCompanion = Resolve-PhysicalPath -Path $companionRoot
$physicalBackupRoot = Resolve-PlannedPath -Path $backupRootPath
if ((Test-WithinDirectory -Path $physicalBackupRoot -Directory $physicalProfilesDirectory) -or
    (Test-WithinDirectory -Path $physicalBackupRoot -Directory $physicalCompanion)) {
    throw 'The backup directory must be outside DSH profiles and this plugin source directory.'
}
foreach ($requiredFile in @('lib\index.js', 'lib\client.js', 'cordis.patch.yml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $companionRoot $requiredFile) -PathType Leaf)) {
        throw "The companion must be built before installation. Missing: $requiredFile"
    }
}
$pnpmCommands = @(Get-Command pnpm.cmd -CommandType Application -ErrorAction Stop)
$pnpm = [string]$pnpmCommands[0].Source
$dependencyArgument = "$pluginName@link:$companionRoot"
$pnpmArguments = @('add', $dependencyArgument, '--ignore-scripts', '--offline')
$relativeFiles = @(
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'cordis.patch.yml',
    'cordis.yml',
    'node_modules\.modules.yaml',
    'node_modules\.pnpm-workspace-state-v1.json'
)
$patchFiles = @('cordis.patch.yml', 'cordis.yml')
$fileRecords = @()
foreach ($relativePath in $relativeFiles) {
    $sourcePath = Join-Path $profilePath $relativePath
    $record = [ordered]@{ relativePath = $relativePath; sourcePath = $sourcePath; existed = $false }
    if ($patchFiles -notcontains $relativePath -and
        -not (Test-WithinDirectory -Path (Resolve-PlannedPath -Path $sourcePath) -Directory $physicalProfile)) {
        throw "A mutable desktop profile path resolves outside the profile: $sourcePath"
    }
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
        $record.existed = $true
        $record['physicalPath'] = Resolve-PhysicalPath -Path $sourcePath
        $record['link'] = Get-FileLinkMetadata -Path $sourcePath
        # pnpm may update the manifest, lock/workspace files, and node_modules metadata.
        # Refuse shared targets outside the desktop profile; patch targets are read-only snapshots.
        if ($patchFiles -notcontains $relativePath -and
            -not (Test-WithinDirectory -Path $record.physicalPath -Directory $physicalProfile)) {
            throw "A mutable desktop profile file resolves outside the profile: $sourcePath -> $($record.physicalPath)"
        }
    }
    $fileRecords += $record
}

Write-Output "Desktop profile: $profilePath"
Write-Output "Companion: $companionRoot"
Write-Output "Backup root: $backupRootPath"
if (-not $PSCmdlet.ShouldProcess($profilePath, "Back up affected desktop profile files to $backupRootPath, verify SHA256, migrate any old bridge name, and install dsh-rider-bridge offline")) {
    return
}
$installId = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$backupDirectory = Join-Path $backupRootPath $installId
New-Item -ItemType Directory -Path $backupDirectory | Out-Null
$metadataPath = Join-Path $backupDirectory 'install-info.json'
$bridgeLinkPath = Join-Path $profilePath "node_modules\$pluginName"
$previousBridgeLink = if (Test-Path -LiteralPath $bridgeLinkPath) {
    [ordered]@{ existed = $true; path = $bridgeLinkPath; link = (Get-FileLinkMetadata -Path $bridgeLinkPath) }
} else { [ordered]@{ existed = $false; path = $bridgeLinkPath } }
$legacyBridgeLinkPath = Join-Path $profilePath "node_modules\$legacyPluginName"
$previousLegacyBridgeLink = if (Test-Path -LiteralPath $legacyBridgeLinkPath) {
    [ordered]@{ existed = $true; path = $legacyBridgeLinkPath; link = (Get-FileLinkMetadata -Path $legacyBridgeLinkPath) }
} else { [ordered]@{ existed = $false; path = $legacyBridgeLinkPath } }
$previousBridgeDependencies = @()
foreach ($sectionName in @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')) {
    $sectionProperty = $package.PSObject.Properties[$sectionName]
    if ($null -eq $sectionProperty) { continue }
    foreach ($dependencyName in @($legacyPluginName, $pluginName)) {
        $dependencyProperty = $sectionProperty.Value.PSObject.Properties[$dependencyName]
        if ($null -ne $dependencyProperty) {
            $previousBridgeDependencies += [ordered]@{
                section = $sectionName
                name = $dependencyName
                value = [string]$dependencyProperty.Value
            }
        }
    }
}
$migratedBundles = @(Convert-BridgeBundleList -Bundles @($package.dsh.profile.bundles) -LegacyName $legacyPluginName -CurrentName $pluginName)
$migration = [ordered]@{
    from = $legacyPluginName
    to = $pluginName
    state = 'planned'
    previousDependencies = $previousBridgeDependencies
    bundlesBefore = @($package.dsh.profile.bundles)
    bundlesAfter = $migratedBundles
    previousLegacyLink = $previousLegacyBridgeLink
}
$metadata = [ordered]@{
    schemaVersion = 1
    status = 'backing-up'
    createdAt = (Get-Date).ToString('o')
    profile = $profilePath
    physicalProfile = $physicalProfile
    companion = $companionRoot
    companionVersion = $companion.version
    backup = $backupDirectory
    pnpm = $pnpm
    commandArguments = $pnpmArguments
    previousBundles = @($package.dsh.profile.bundles)
    previousBridgeLink = $previousBridgeLink
    migration = $migration
    files = $fileRecords
    recoveryNotes = @(
        'Stop DSH before restoring profile configuration.'
        'For each files entry with existed=true, verify backupRelativePath against sha256 and restore its bytes to sourcePath; preserve any recorded symbolic link and physicalPath.'
        'Entries with existed=false identify files absent before this installation. Review and remove newly created files only when restoring.'
        'Restore the old manifest and lock/workspace files before using pnpm install --ignore-scripts --offline in this desktop profile to reconcile node_modules.'
        'The prior bridge names, dependency values, node_modules links, and bundle position are recorded in migration and previousBridgeLink. Restore only this selected desktop profile.'
    )
}
function Save-InstallMetadata {
    [IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 100) + [Environment]::NewLine, $utf8)
}
Write-Output "Profile configuration backup: $backupDirectory"
Save-InstallMetadata

try {
    foreach ($record in $fileRecords) {
        if (-not $record.existed) { continue }
        $backupRelativePath = Join-Path 'files' $record.relativePath
        $backupPath = Join-Path $backupDirectory $backupRelativePath
        New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
        # Reading bytes follows a file symlink and writes an ordinary backup file, never another link.
        $bytes = [IO.File]::ReadAllBytes($record.sourcePath)
        [IO.File]::WriteAllBytes($backupPath, $bytes)
        $sourceHash = (Get-FileHash -LiteralPath $record.sourcePath -Algorithm SHA256).Hash
        $backupHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
        if ($sourceHash -ne $backupHash) { throw "Backup verification failed: $($record.sourcePath)" }
        $record['backupRelativePath'] = $backupRelativePath
        $record['sha256'] = $backupHash
        $record['length'] = $bytes.LongLength
    }
    $metadata.status = 'backed-up'
    $metadata['backupsVerifiedAt'] = (Get-Date).ToString('o')
    Save-InstallMetadata

    if (-not (Test-WithinDirectory -Path (Resolve-PhysicalPath -Path $packagePath) -Directory $physicalProfile)) {
        throw 'The package manifest resolves outside the desktop profile; no migration was made.'
    }
    $package = [IO.File]::ReadAllText($packagePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    # Replace the legacy dependency before pnpm so it can prune the old local package link.
    $package = Convert-BridgeManifest -Manifest $package -LegacyName $legacyPluginName -CurrentName $pluginName -DependencyValue "link:$companionRoot"
    [IO.File]::WriteAllText($packagePath, ($package | ConvertTo-Json -Depth 100) + [Environment]::NewLine, $utf8)
    $migration.state = 'manifest-updated'
    $migration['manifestUpdatedAt'] = (Get-Date).ToString('o')
    $migration.bundlesAfter = @($package.dsh.profile.bundles)
    Save-InstallMetadata

    Push-Location -LiteralPath $profilePath
    try {
        & $pnpm @pnpmArguments
        if ($LASTEXITCODE -ne 0) { throw "pnpm add failed with exit code $LASTEXITCODE." }
    }
    finally { Pop-Location }

    if (-not (Test-WithinDirectory -Path (Resolve-PhysicalPath -Path $packagePath) -Directory $physicalProfile)) {
        throw 'The package manifest resolves outside the desktop profile after pnpm; no bundle edit was made.'
    }
    $package = [IO.File]::ReadAllText($packagePath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $bridgeBundles = @($package.dsh.profile.bundles | Where-Object { $_ -eq $pluginName })
    if ($bridgeBundles.Count -ne 1 -or @($package.dsh.profile.bundles) -contains $legacyPluginName) {
        throw 'The desktop bridge bundle list did not retain the expected single migrated entry.'
    }
    foreach ($sectionName in @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')) {
        $sectionProperty = $package.PSObject.Properties[$sectionName]
        if ($null -ne $sectionProperty -and $null -ne $sectionProperty.Value.PSObject.Properties[$legacyPluginName]) {
            throw "The legacy dependency remains after pnpm: $sectionName/$legacyPluginName"
        }
    }
    # The bundle supplies its own patch. The desktop cordis files are never edited here.
    foreach ($record in $fileRecords) {
        if ($patchFiles -notcontains $record.relativePath) { continue }
        $existsNow = Test-Path -LiteralPath $record.sourcePath -PathType Leaf
        if ($existsNow -ne $record.existed -or
            ($record.existed -and (Get-FileHash -LiteralPath $record.sourcePath -Algorithm SHA256).Hash -ne $record.sha256)) {
            throw "A desktop Cordis configuration changed during installation: $($record.sourcePath). Its original snapshot is in the backup."
        }
    }

    # pnpm owns dependency links; never move or delete linked source directories here.
    $migration['legacyLinkStillPresent'] = [bool](Get-Item -LiteralPath $legacyBridgeLinkPath -Force -ErrorAction SilentlyContinue)
    if ($migration.legacyLinkStillPresent) {
        Write-Warning 'An unreferenced old bridge link remains in node_modules. The old dependency and bundle entry have been removed; pnpm manages the remaining link.'
    }
    $metadata.status = 'installed'
    $metadata['completedAt'] = (Get-Date).ToString('o')
    $metadata['installedPackageSha256'] = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash
    $migration.state = 'completed'
    $migration['completedAt'] = (Get-Date).ToString('o')
    Save-InstallMetadata
}
catch {
    $metadata.status = 'failed'
    $metadata['failedAt'] = (Get-Date).ToString('o')
    $metadata['error'] = $_.Exception.Message
    Save-InstallMetadata
    Write-Warning "Installation did not complete. Verified backups and recovery metadata: $backupDirectory"
    throw
}

Write-Output "Installed companion: $pluginName"
Write-Output "Recovery metadata: $metadataPath"
Write-Output 'Restart DSH to activate the desktop bundle. This installer does not interrupt running conversations.'
