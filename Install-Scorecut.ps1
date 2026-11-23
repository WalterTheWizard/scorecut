$ErrorActionPreference = 'Stop'
$destination = Join-Path $env:LOCALAPPDATA 'Scorecut'
$python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
$venv = Join-Path $destination '.venv'
$runtime = Join-Path $venv 'Scripts\python.exe'
$windowless = Join-Path $venv 'Scripts\pythonw.exe'
$app = Join-Path $destination 'app.py'

function Find-Python {
    if (Test-Path $python) { return $python }
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        # An installed launcher can legitimately have no Python 3.12 runtime.
        $probe = New-Object System.Diagnostics.ProcessStartInfo
        $probe.FileName = $launcher.Source
        $probe.Arguments = '-3.12 -c "import sys; print(sys.executable)"'
        $probe.UseShellExecute = $false
        $probe.CreateNoWindow = $true
        $probe.RedirectStandardOutput = $true
        $probe.RedirectStandardError = $true
        $process = [System.Diagnostics.Process]::Start($probe)
        try {
            $answer = $process.StandardOutput.ReadToEnd().Trim()
            $process.StandardError.ReadToEnd() | Out-Null
            $process.WaitForExit()
            if ($process.ExitCode -eq 0 -and $answer -and (Test-Path -LiteralPath $answer -PathType Leaf)) {
                return $answer
            }
        } finally {
            $process.Dispose()
        }
    }
    return $null
}

if (-not (Test-Path $runtime)) {
    $basePython = Find-Python
    if (-not $basePython) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $winget) {
            throw 'Install Python 3.12 from python.org, then run this setup again.'
        }
        Write-Host 'Installing Python 3.12 for your Windows account...'
        & $winget.Source install --id Python.Python.3.12 --exact --scope user --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { throw 'Python setup returned an error.' }
        $basePython = Find-Python
        if (-not $basePython) { throw 'Python 3.12 was installed but could not be located. Run setup again from a new window.' }
    }
    New-Item -Path $destination -ItemType Directory -Force | Out-Null
    & $basePython -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Scorecut runtime.' }
}

Write-Host 'Installing PDF and video components...'
& $runtime -m pip --disable-pip-version-check install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not download Scorecut dependencies. Check your internet connection and run setup again.' }

Copy-Item (Join-Path $PSScriptRoot 'app.py') $app -Force
New-Item -Path (Join-Path $destination 'web') -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'web\*') (Join-Path $destination 'web') -Force

$shell = New-Object -ComObject WScript.Shell
$programs = [Environment]::GetFolderPath('Programs')
$link = $shell.CreateShortcut((Join-Path $programs 'Scorecut.lnk'))
$link.TargetPath = $windowless
$link.Arguments = '"' + $app + '" --desktop'
$link.WorkingDirectory = $destination
$link.Description = 'Scorecut score video editor'
$link.IconLocation = (Join-Path $destination 'web\scorecut.ico') + ',0'
$link.Save()
Write-Host 'Scorecut is installed. You can reopen it from the Windows Start menu.'
Start-Process -FilePath (Join-Path $programs 'Scorecut.lnk')
