# What the desktop shortcut runs.
#
# Ferrum is a local engine plus a browser page, not a packaged desktop app, so "open Ferrum" means
# two things: make sure the engine is up, then point a browser at it. This launcher wraps that in a
# small branded dialog so the ONE shortcut can Start it when it is down, or Open / Restart it when it
# is already running — the Restart being what loads a new version, which a plain "open the browser"
# launcher could never do.
#
# The rules it still follows:
#
#   NEVER start a SECOND engine. Two engines on one database corrupts the SQLite file. If one is
#   already answering, the only ways forward are Open (use it) or Restart (stop it, then start one).
#
#   NEVER leave a failure silent. Every exit path either opens the browser or says why it could not,
#   in a dialog, with the log.
#
#   The engine OUTLIVES this script — started detached — so closing the launcher never takes it down.
#
# Run by hand for diagnostics:
#   powershell -ExecutionPolicy Bypass -File scripts\launch-ferrum.ps1

$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $PSScriptRoot
$LogDir  = Join-Path $env:LOCALAPPDATA 'ferrum'
$LogFile   = Join-Path $LogDir 'launcher.log'
$EngineLog = Join-Path $LogDir 'engine.log'
$IconPath  = Join-Path $Root 'web\public\favicon.ico'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ── Ferrum's own palette (web/src/styles/tokens.css, dark theme) so the dialog matches the app ──────
$C_BG      = [System.Drawing.Color]::FromArgb(0x17,0x19,0x1a)  # --canvas
$C_SUNK    = [System.Drawing.Color]::FromArgb(0x1d,0x20,0x21)  # --canvas-sunk
$C_BORDER  = [System.Drawing.Color]::FromArgb(0x2c,0x30,0x31)
$C_INK     = [System.Drawing.Color]::FromArgb(0xe8,0xea,0xeb)  # --ink
$C_MUTE    = [System.Drawing.Color]::FromArgb(0x9a,0xa2,0xa8)  # --ink-mute
$C_PRIMARY = [System.Drawing.Color]::FromArgb(0x12,0x7c,0x71)  # --primary
$C_PRIMHOV = [System.Drawing.Color]::FromArgb(0x16,0x94,0x86)  # --primary-deep (dark: lighter on hover)
$C_GHOSTHV = [System.Drawing.Color]::FromArgb(0x23,0x26,0x28)

function Write-Log([string]$msg) {
    try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Add-Content -Path $LogFile -Encoding utf8 -ErrorAction Stop } catch { }
}

function Test-Port([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $wait = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $wait.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($wait); return $true
    } catch { return $false } finally { $client.Close() }
}

function Get-Port {
    $p = 4317
    $envFile = Join-Path $Root '.env'
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
        if ($line) { $p = [int]$line.Matches[0].Groups[1].Value }
    }
    return $p
}

# ── Small GUI helpers ──────────────────────────────────────────────────────────────────────────────
function New-RoundedPath([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-Pill([string]$text, $back, $fore, $hover, [int]$w, [bool]$outlined) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Width = $w; $b.Height = 38
    $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0
    $b.ForeColor = $fore; $b.BackColor = $back
    $b.Font = New-Object System.Drawing.Font('Segoe UI', 9.75, [System.Drawing.FontStyle]::Regular)
    $b.Cursor = 'Hand'; $b.TabStop = $false
    if ($outlined) { $b.FlatAppearance.BorderSize = 1; $b.FlatAppearance.BorderColor = $script:C_BORDER }
    $b.Region = New-Object System.Drawing.Region((New-RoundedPath 0 0 $b.Width $b.Height 10))
    $b.Add_MouseEnter({ $this.BackColor = $hover }.GetNewClosure())
    $b.Add_MouseLeave({ $this.BackColor = $back }.GetNewClosure())
    return $b
}

# Build the launcher dialog. Returns the form; the caller reads $form.Tag ('open'|'restart'|'start'|'cancel').
function New-LauncherForm([bool]$running, [int]$port) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $f = New-Object System.Windows.Forms.Form
    $f.FormBorderStyle = 'None'; $f.StartPosition = 'CenterScreen'
    $f.Size = New-Object System.Drawing.Size(460, 250)
    $f.BackColor = $script:C_BG
    $f.Tag = 'cancel'
    if (Test-Path $script:IconPath) { try { $f.Icon = New-Object System.Drawing.Icon($script:IconPath) } catch {} }
    $f.Region = New-Object System.Drawing.Region((New-RoundedPath 0 0 $f.Width $f.Height 16))
    $f.Add_Paint({
        param($s, $e)
        $e.Graphics.SmoothingMode = 'AntiAlias'
        $pen = New-Object System.Drawing.Pen($script:C_BORDER, 1)
        $e.Graphics.DrawPath($pen, (New-RoundedPath 0 0 ($s.Width - 1) ($s.Height - 1) 16))
    })
    # Drag anywhere on the header via the Win32 caption trick.
    $f.Add_MouseDown({ if ($_.Button -eq 'Left') { [FerrumDrag]::Go($f.Handle) } }.GetNewClosure())

    # Logo
    if (Test-Path $script:IconPath) {
        $logo = New-Object System.Windows.Forms.PictureBox
        $logo.SizeMode = 'Zoom'; $logo.Size = New-Object System.Drawing.Size(30, 30)
        $logo.Location = New-Object System.Drawing.Point(26, 24)
        try { $logo.Image = (New-Object System.Drawing.Icon($script:IconPath, 64, 64)).ToBitmap() } catch {}
        $logo.Add_MouseDown({ if ($_.Button -eq 'Left') { [FerrumDrag]::Go($f.Handle) } }.GetNewClosure())
        $f.Controls.Add($logo)
    }
    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'Ferrum'; $title.AutoSize = $true
    $title.ForeColor = $script:C_INK
    $title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 15)
    $title.Location = New-Object System.Drawing.Point(64, 27)
    $title.BackColor = [System.Drawing.Color]::Transparent
    $title.Add_MouseDown({ if ($_.Button -eq 'Left') { [FerrumDrag]::Go($f.Handle) } }.GetNewClosure())
    $f.Controls.Add($title)

    # Close ×
    $close = New-Object System.Windows.Forms.Label
    $close.Text = [char]0x00D7; $close.AutoSize = $false
    $close.Size = New-Object System.Drawing.Size(30, 30)
    $close.TextAlign = 'MiddleCenter'
    $close.Font = New-Object System.Drawing.Font('Segoe UI', 15)
    $close.ForeColor = $script:C_MUTE; $close.BackColor = [System.Drawing.Color]::Transparent
    $close.Location = New-Object System.Drawing.Point(($f.Width - 44), 20)
    $close.Cursor = 'Hand'
    $close.Add_MouseEnter({ $this.ForeColor = $script:C_INK })
    $close.Add_MouseLeave({ $this.ForeColor = $script:C_MUTE })
    $close.Add_Click({ $f.Tag = 'cancel'; $f.Close() }.GetNewClosure())
    $f.Controls.Add($close)

    # Heading + subtext
    $head = New-Object System.Windows.Forms.Label
    $head.AutoSize = $false; $head.Size = New-Object System.Drawing.Size(408, 26)
    $head.Location = New-Object System.Drawing.Point(26, 82)
    $head.ForeColor = $script:C_INK
    $head.Font = New-Object System.Drawing.Font('Segoe UI', 12)
    $head.BackColor = [System.Drawing.Color]::Transparent
    $sub = New-Object System.Windows.Forms.Label
    $sub.AutoSize = $false; $sub.Size = New-Object System.Drawing.Size(408, 40)
    $sub.Location = New-Object System.Drawing.Point(26, 110)
    $sub.ForeColor = $script:C_MUTE
    $sub.Font = New-Object System.Drawing.Font('Segoe UI', 9.75)
    $sub.BackColor = [System.Drawing.Color]::Transparent
    if ($running) {
        $head.Text = 'Ferrum is already running.'
        $sub.Text  = "Open the app you have, or restart it to load the latest version."
    } else {
        $head.Text = 'Ferrum is not running.'
        $sub.Text  = "Start the engine and open it in your browser."
    }
    $f.Controls.Add($head); $f.Controls.Add($sub)

    # Buttons, right-aligned along the bottom
    $y = 178
    $mk = {
        param($text, $back, $fore, $hover, $w, $outlined, $tag)
        $b = New-Pill $text $back $fore $hover $w $outlined
        $b.Add_Click({ $f.Tag = $tag; $f.Close() }.GetNewClosure())
        return $b
    }
    if ($running) {
        $open    = & $mk 'Open Ferrum' $script:C_PRIMARY ([System.Drawing.Color]::White) $script:C_PRIMHOV 128 $false 'open'
        $restart = & $mk 'Restart'     $script:C_SUNK    $script:C_INK                    $script:C_GHOSTHV 96  $true  'restart'
        $cancel  = & $mk 'Cancel'      $script:C_BG      $script:C_MUTE                   $script:C_GHOSTHV 80  $false 'cancel'
        $open.Location    = New-Object System.Drawing.Point(($f.Width - 26 - $open.Width), $y)
        $restart.Location = New-Object System.Drawing.Point(($open.Left - 10 - $restart.Width), $y)
        $cancel.Location  = New-Object System.Drawing.Point(($restart.Left - 6 - $cancel.Width), $y)
        $f.Controls.Add($open); $f.Controls.Add($restart); $f.Controls.Add($cancel)
        $f.AcceptButton = $open
    } else {
        $start  = & $mk 'Start Ferrum' $script:C_PRIMARY ([System.Drawing.Color]::White) $script:C_PRIMHOV 128 $false 'start'
        $cancel = & $mk 'Cancel'       $script:C_BG      $script:C_MUTE                  $script:C_GHOSTHV 80  $false 'cancel'
        $start.Location  = New-Object System.Drawing.Point(($f.Width - 26 - $start.Width), $y)
        $cancel.Location = New-Object System.Drawing.Point(($start.Left - 6 - $cancel.Width), $y)
        $f.Controls.Add($start); $f.Controls.Add($cancel)
        $f.AcceptButton = $start
    }
    return $f
}

function Show-LauncherDialog([bool]$running, [int]$port) {
    $f = New-LauncherForm $running $port
    [void]$f.ShowDialog()
    $tag = $f.Tag; $f.Dispose()
    return $tag
}

function Show-Problem([string]$summary) {
    Add-Type -AssemblyName System.Windows.Forms
    $tail = if (Test-Path $EngineLog) { (Get-Content $EngineLog -Tail 15) -join "`n" } else { '(the engine produced no output)' }
    [System.Windows.Forms.MessageBox]::Show(
        "$summary`n`nEngine log: $EngineLog`nLauncher log: $LogFile`n`n$tail",
        'Ferrum could not start',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    exit 1
}

# Stop the engine currently answering on $port. Runs in the user's own session (the shortcut), so it
# has the right to kill it — walking up to the cmd/npm parent so nothing respawns the worker.
function Stop-Engine([int]$port) {
    $owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if (-not $owner) { return }
    $chain = @(); $cur = $owner
    for ($i = 0; $i -lt 8 -and $cur; $i++) {
        $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue
        if (-not $pr) { break }
        if ($pr.CommandLine -match 'claycode|tsx|npm|ferrum') { $chain += $cur; $cur = $pr.ParentProcessId } else { break }
    }
    foreach ($procId in $chain) { taskkill /PID $procId /T /F 2>&1 | Out-Null }
    for ($i = 0; $i -lt 25 -and (Test-Port $port); $i++) { Start-Sleep -Milliseconds 200 }
    Write-Log "Stopped the engine on $port for a restart"
}

# Cold-start the engine and open the browser. Builds the client once if it has never been built.
function Start-Engine([int]$port, [string]$url) {
    if (-not (Test-Path (Join-Path $Root 'web\dist\index.html'))) {
        Write-Log 'web/dist missing — building the client first (one time)'
        Push-Location $Root
        & cmd.exe /c "npm run web:build >> `"$EngineLog`" 2>&1"
        Pop-Location
        if (-not (Test-Path (Join-Path $Root 'web\dist\index.html'))) {
            Show-Problem 'The app could not be built. Node may not be installed, or `npm install` has not been run yet.'
        }
    }
    if (Test-Path $EngineLog) { Remove-Item $EngineLog -ErrorAction SilentlyContinue }
    Write-Log "Starting the engine on $port"
    Start-Process -FilePath 'cmd.exe' `
                  -ArgumentList '/c', "npm start >> `"$EngineLog`" 2>&1" `
                  -WorkingDirectory $Root `
                  -WindowStyle Hidden
    $deadline = (Get-Date).AddSeconds(45)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $port) { Write-Log "Up on $port — opening $url"; Start-Process $url; return }
        Start-Sleep -Milliseconds 400
    }
    Show-Problem "The engine did not come up on port $port within 45 seconds."
}

# ── Win32 drag helper (used by the borderless dialog) ──────────────────────────────────────────────
if (-not ('FerrumDrag' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class FerrumDrag {
    [DllImport("user32.dll")] public static extern bool ReleaseCapture();
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);
    public static void Go(IntPtr h) { ReleaseCapture(); SendMessage(h, 0xA1, 0x2, 0); }
}
"@
}

# ── Main ───────────────────────────────────────────────────────────────────────────────────────────
# Guarded so the file can be dot-sourced for testing without launching anything.
if ($env:FERRUM_LAUNCHER_NOEXEC -ne '1') {
    try {
        if (-not (Test-Path (Join-Path $Root 'package.json'))) {
            Show-Problem "Ferrum is not where this shortcut expects it:`n$Root`n`nIf you moved the project folder, re-create the shortcut."
        }
        $Port = Get-Port
        $Url  = "http://127.0.0.1:$Port"
        $running = Test-Port $Port

        $choice = Show-LauncherDialog $running $Port
        Write-Log "Dialog: running=$running choice=$choice"

        switch ($choice) {
            'open'    { Start-Process $Url }
            'start'   { Start-Engine $Port $Url }
            'restart' { Stop-Engine $Port; Start-Engine $Port $Url }
            default   { }   # cancel — do nothing
        }
    }
    catch {
        Write-Log "FAILED: $_"
        Show-Problem "Something went wrong starting Ferrum.`n`n$_"
    }
}
