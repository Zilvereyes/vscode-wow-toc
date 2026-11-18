param([switch]$Verify)

$ErrorActionPreference = 'Stop'
$code = (Get-Command code.cmd -CommandType Application -ErrorAction Stop).Source
$codeExe = Join-Path (Split-Path (Split-Path $code)) 'Code.exe'
$profileRoot = Join-Path ([IO.Path]::GetTempPath()) ('wow-toc-preview-' + [guid]::NewGuid().ToString('N'))
$userData = Join-Path $profileRoot 'profile'
$extensions = Join-Path $profileRoot 'extensions'
$userFolder = Join-Path $userData 'User'
New-Item -Path $userFolder, $extensions -ItemType Directory | Out-Null
@{
    'workbench.colorTheme' = 'WoW TOC Theme'
    'window.autoDetectColorScheme' = $false
    'workbench.startupEditor' = 'none'
    'telemetry.telemetryLevel' = 'off'
    'update.mode' = 'none'
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $userFolder 'settings.json') -Encoding utf8

$arguments = @(
    '--new-window'
    '--skip-welcome'
    '--skip-release-notes'
    '--user-data-dir', $userData
    '--extensions-dir', $extensions
    "--extensionDevelopmentPath=$PSScriptRoot"
)
if ($Verify) {
    $arguments += "--extensionTestsPath=$(Join-Path $PSScriptRoot 'tests\editor.cjs')"
    $receipt = Join-Path $profileRoot 'editor-verification.json'
    $env:WOW_TOC_TEST_RECEIPT = $receipt
    $quotedArguments = $arguments | ForEach-Object { '"' + $_ + '"' }
    try {
        $process = Start-Process -FilePath $codeExe -ArgumentList $quotedArguments -WindowStyle Hidden -PassThru
        if (-not $process.WaitForExit(45000)) {
            throw "VS Code verification timed out. Profile: $profileRoot"
        }
        if ($process.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $receipt)) {
            throw "VS Code verification failed (exit $($process.ExitCode)). Profile: $profileRoot"
        }
        Get-Content -LiteralPath $receipt -Raw
    } finally {
        Remove-Item Env:WOW_TOC_TEST_RECEIPT -ErrorAction SilentlyContinue
    }
    return
}

$arguments += Join-Path $PSScriptRoot 'tests\fixtures\Preview.toc'
& $code @arguments
if ($LASTEXITCODE -ne 0) {
    throw "VS Code returned exit code $LASTEXITCODE"
}
