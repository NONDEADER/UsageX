# UsageX Build Script
# Generates UsageX-firefox-vX.X.X.zip and UsageX-chrome-vX.X.X.zip
# Usage: .\build.ps1

$Root = $PSScriptRoot
$ManifestData = Get-Content (Join-Path $Root 'manifest.json') | ConvertFrom-Json
$Version = $ManifestData.version

$CommonFiles = @(
    'background.js',
    'content.js',
    'db.js',
    'debug-viewer.css',
    'debug-viewer.html',
    'debug-viewer.js',
    'inject-loader.js',
    'inject.js',
    'popup.css',
    'popup.html',
    'popup.js',
    'privacy-policy.html',
    'icons'
)

function Build-Zip {
    param(
        [string]$ManifestSource,
        [string]$OutputZip
    )

    $TempDir = Join-Path $Root '_build_temp'
    if (Test-Path $TempDir) { Remove-Item $TempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $TempDir | Out-Null

    foreach ($item in $CommonFiles) {
        $src = Join-Path $Root $item
        $dst = Join-Path $TempDir $item
        if (Test-Path $src -PathType Container) {
            Copy-Item $src $dst -Recurse
        } elseif (Test-Path $src) {
            Copy-Item $src $dst
        } else {
            Write-Warning "  Skipping missing: $item"
        }
    }

    Copy-Item $ManifestSource (Join-Path $TempDir 'manifest.json')

    $OutPath = Join-Path $Root $OutputZip
    if (Test-Path $OutPath) { Remove-Item $OutPath -Force }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zipStream = [System.IO.File]::OpenWrite($OutPath)
    $archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
    $files = Get-ChildItem -Path $TempDir -Recurse -File
    foreach ($file in $files) {
        $relativeName = $file.FullName.Substring($TempDir.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar)
        $entryName = $relativeName.Replace('\', '/')
        $entry = $archive.CreateEntry($entryName)
        $entryStream = $entry.Open()
        $fileStream = [System.IO.File]::OpenRead($file.FullName)
        $fileStream.CopyTo($entryStream)
        $fileStream.Close()
        $entryStream.Close()
    }
    $archive.Dispose()
    $zipStream.Close()

    Remove-Item $TempDir -Recurse -Force
    Write-Host "  Built: $OutputZip" -ForegroundColor Green
}

Write-Host ''
Write-Host "UsageX v$Version -- Building..." -ForegroundColor Cyan
Write-Host ''

Write-Host '[1/2] Firefox + Firefox for Android'
Build-Zip `
    -ManifestSource (Join-Path $Root 'manifest.json') `
    -OutputZip "UsageX-firefox-v$Version.zip"

Write-Host '[2/2] Chrome + Kiwi Browser'
Build-Zip `
    -ManifestSource (Join-Path $Root 'manifest.chrome.json') `
    -OutputZip "UsageX-chrome-v$Version.zip"

Write-Host ''
Write-Host 'Done! Check your UsageX folder for the zips.' -ForegroundColor Cyan
Write-Host ''
