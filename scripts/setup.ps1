# Checks the development toolchain and prepares the Julia and frontend environments.
# It installs nothing system-wide: missing tools are reported with a hint.
#
# Usage (from the repository root): powershell -ExecutionPolicy Bypass -File scripts\setup.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$missing = @()

function Test-Tool($name, $hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        Write-Host ("[missing] {0,-8} {1}" -f $name, $hint) -ForegroundColor Yellow
        $script:missing += $name
    } else {
        $version = (& $name --version 2>&1 | Select-Object -First 1)
        Write-Host ("[ok]      {0,-8} {1}" -f $name, $version)
    }
}

Test-Tool 'git'    'https://git-scm.com'
Test-Tool 'rustup' 'https://rustup.rs'
Test-Tool 'cargo'  'installed with rustup'
Test-Tool 'julia'  'install juliaup: https://github.com/JuliaLang/juliaup'
Test-Tool 'node'   'Node.js LTS (MSI or portable zip), its folder must be on PATH'
Test-Tool 'pnpm'   'npm install -g pnpm'

if (Get-Command rustup -ErrorAction SilentlyContinue) {
    # rust-toolchain.toml says `stable` (it must also work on Linux), so the Windows host
    # triple comes from rustup's default host. Tauri needs the MSVC toolchain.
    $hostLine = (rustup show 2>&1 | Where-Object { $_ -match '^Default host:' } | Select-Object -First 1)
    if ($hostLine -match 'x86_64-pc-windows-msvc') {
        Write-Host "[ok]      rustup   default host is x86_64-pc-windows-msvc"
    } else {
        Write-Host "[missing] rustup   default host is not MSVC ($hostLine). Run: rustup set default-host x86_64-pc-windows-msvc" -ForegroundColor Yellow
        Write-Host "                   (or set RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-msvc for the current shell)" -ForegroundColor Yellow
        $missing += 'rustup-msvc-host'
    }
    rustup show active-toolchain | Out-Null
}

# MSVC build tools are needed by Tauri on Windows.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if ((Test-Path $vswhere) -and (& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName)) {
    Write-Host "[ok]      MSVC     C++ build tools found"
} else {
    Write-Host "[missing] MSVC     install Visual Studio Build Tools with 'Desktop development with C++'" -ForegroundColor Yellow
    $missing += 'msvc'
}

if (Get-Command julia -ErrorAction SilentlyContinue) {
    Write-Host "Instantiating Julia environments..."
    julia --project=kernel/EqRuntime -e "using Pkg; Pkg.instantiate()"
    julia --project=kernel/EquavelaKernel -e "using Pkg; Pkg.instantiate()"
}

if ((Test-Path app/package.json) -and (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "Installing frontend dependencies..."
    pnpm --dir app install
}

if ($missing.Count -gt 0) {
    Write-Host ("Setup incomplete, missing: {0}" -f ($missing -join ', ')) -ForegroundColor Yellow
    exit 1
}
Write-Host "Setup complete." -ForegroundColor Green
