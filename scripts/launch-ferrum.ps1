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

# Load the GUI assemblies FIRST — a fresh powershell.exe (which the shortcut launches) has not loaded
# them, and the dialog is built from them below. Missing this made the script crash with the console
# hidden, i.e. "double-click does nothing". The dialog is WPF (vector, real rounded corners, a soft
# drop shadow, ClearType text — far cleaner than WinForms); WinForms is kept only for the rare
# error-fallback MessageBox.
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

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

# Build the launcher dialog as a WPF window and return it (not shown yet, so it stays testable).
# The window, the chosen action, and the primary button's meaning all live in SCRIPT scope so the
# click handlers still resolve them after this function returns — a function-local would be gone by
# the time ShowDialog (in Show-LauncherDialog) fires a handler. A handler writes $script:launcherChoice
# ('open'|'restart'|'start'); Esc, the ×, and closing the window leave it at its 'cancel' default.
function New-LauncherWindow([bool]$running) {
    $script:primaryChoice = if ($running) { 'open' } else { 'start' }

    [xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" SizeToContent="WidthAndHeight"
        WindowStartupLocation="CenterScreen" ShowInTaskbar="True" Topmost="True"
        FontFamily="Segoe UI" TextOptions.TextFormattingMode="Ideal" TextOptions.TextRenderingMode="ClearType">
  <Window.Resources>
    <Style x:Key="Primary" TargetType="Button">
      <Setter Property="Foreground" Value="#FFFFFF"/>
      <Setter Property="FontSize" Value="12.5"/><Setter Property="Height" Value="38"/>
      <Setter Property="MinWidth" Value="122"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="SnapsToDevicePixels" Value="True"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="Button">
          <Border x:Name="bd" CornerRadius="9" Background="#127c71" Padding="18,0">
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="bd" Property="Background" Value="#169486"/></Trigger>
            <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="bd" Property="Background" Value="#169486"/></Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value></Setter>
    </Style>
    <Style x:Key="Ghost" TargetType="Button">
      <Setter Property="Foreground" Value="#e8eaeb"/>
      <Setter Property="FontSize" Value="12.5"/><Setter Property="Height" Value="38"/>
      <Setter Property="MinWidth" Value="94"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="SnapsToDevicePixels" Value="True"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="Button">
          <Border x:Name="bd" CornerRadius="9" Background="#1d2021" BorderBrush="#2c3031" BorderThickness="1" Padding="18,0">
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="bd" Property="Background" Value="#26292b"/>
              <Setter TargetName="bd" Property="BorderBrush" Value="#3a3f41"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value></Setter>
    </Style>
    <Style x:Key="GhostText" TargetType="Button">
      <Setter Property="Foreground" Value="#9aa2a8"/>
      <Setter Property="FontSize" Value="12.5"/><Setter Property="Height" Value="38"/>
      <Setter Property="MinWidth" Value="76"/><Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="Button">
          <Border x:Name="bd" CornerRadius="9" Background="Transparent" Padding="16,0">
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="bd" Property="Background" Value="#1d2021"/>
              <Setter Property="Foreground" Value="#e8eaeb"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value></Setter>
    </Style>
    <Style x:Key="CloseStyle" TargetType="Button">
      <Setter Property="Foreground" Value="#9aa2a8"/>
      <Setter Property="FontSize" Value="14"/><Setter Property="Width" Value="30"/><Setter Property="Height" Value="30"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template"><Setter.Value>
        <ControlTemplate TargetType="Button">
          <Border x:Name="bd" CornerRadius="8" Background="Transparent">
            <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
          </Border>
          <ControlTemplate.Triggers>
            <Trigger Property="IsMouseOver" Value="True">
              <Setter TargetName="bd" Property="Background" Value="#26292b"/>
              <Setter Property="Foreground" Value="#e8eaeb"/>
            </Trigger>
          </ControlTemplate.Triggers>
        </ControlTemplate>
      </Setter.Value></Setter>
    </Style>
  </Window.Resources>
  <Window.Triggers>
    <EventTrigger RoutedEvent="Window.Loaded">
      <BeginStoryboard><Storyboard>
        <DoubleAnimation Storyboard.TargetProperty="Opacity" From="0" To="1" Duration="0:0:0.13"/>
      </Storyboard></BeginStoryboard>
    </EventTrigger>
  </Window.Triggers>
  <Border Margin="26" CornerRadius="15" Background="#17191a" BorderBrush="#2c3031" BorderThickness="1">
    <Border.Effect><DropShadowEffect BlurRadius="38" ShadowDepth="9" Direction="270" Color="#000000" Opacity="0.6"/></Border.Effect>
    <Grid Width="420" Margin="30,26,30,28">
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
      </Grid.RowDefinitions>
      <Grid Grid.Row="0">
        <StackPanel Orientation="Horizontal" HorizontalAlignment="Left" VerticalAlignment="Center">
          <Border Width="34" Height="34" CornerRadius="8" Background="#127c71">
            <Grid>
              <TextBlock Text="26" FontFamily="Consolas" FontSize="7.5" Foreground="#FFFFFF" Opacity="0.72"
                         HorizontalAlignment="Left" VerticalAlignment="Top" Margin="5,3.5,0,0"/>
              <TextBlock Text="Fe" FontSize="16.5" FontWeight="SemiBold" Foreground="#FFFFFF"
                         HorizontalAlignment="Center" VerticalAlignment="Center" Margin="0,2,0,0"/>
            </Grid>
          </Border>
          <TextBlock Text="Ferrum" FontSize="17" FontWeight="SemiBold" Foreground="#e8eaeb" Margin="13,0,0,0" VerticalAlignment="Center"/>
        </StackPanel>
        <Button x:Name="CloseBtn" Style="{StaticResource CloseStyle}" Content="&#x2715;"
                HorizontalAlignment="Right" VerticalAlignment="Top" Margin="0,-4,-6,0"/>
      </Grid>
      <StackPanel Grid.Row="1" Margin="0,24,0,0">
        <TextBlock x:Name="HeadText" FontSize="15.5" Foreground="#e8eaeb" TextWrapping="Wrap"/>
        <TextBlock x:Name="SubText" FontSize="11.5" Foreground="#9aa2a8" TextWrapping="Wrap" Margin="0,8,0,0" LineHeight="18"/>
      </StackPanel>
      <StackPanel Grid.Row="2" Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,28,0,0">
        <Button x:Name="BtnCancel" Style="{StaticResource GhostText}" Content="Cancel" IsCancel="True"/>
        <Button x:Name="BtnRestart" Style="{StaticResource Ghost}" Content="Restart" Margin="9,0,0,0"/>
        <Button x:Name="BtnPrimary" Style="{StaticResource Primary}" Content="Open Ferrum" Margin="9,0,0,0" IsDefault="True"/>
      </StackPanel>
    </Grid>
  </Border>
</Window>
"@

    $script:launcherWin = [System.Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
    $win = $script:launcherWin

    $head    = $win.FindName('HeadText')
    $sub     = $win.FindName('SubText')
    $primary = $win.FindName('BtnPrimary')
    $restart = $win.FindName('BtnRestart')
    $cancel  = $win.FindName('BtnCancel')
    $close   = $win.FindName('CloseBtn')

    if ($running) {
        $head.Text = 'Ferrum is already running.'
        $sub.Text  = 'Open the app you have, or restart it to load the latest version.'
        $primary.Content = 'Open Ferrum'
        $restart.Visibility = 'Visible'
    } else {
        $head.Text = 'Ferrum is not running.'
        $sub.Text  = 'Start the engine and open it in your browser.'
        $primary.Content = 'Start Ferrum'
        $restart.Visibility = 'Collapsed'
    }

    $primary.Add_Click({ $script:launcherChoice = $script:primaryChoice; $script:launcherWin.Close() })
    $restart.Add_Click({ $script:launcherChoice = 'restart'; $script:launcherWin.Close() })
    $cancel.Add_Click({  $script:launcherChoice = 'cancel';  $script:launcherWin.Close() })
    $close.Add_Click({   $script:launcherChoice = 'cancel';  $script:launcherWin.Close() })

    # Frameless window: drag it by its body. Bring it to the front when it opens (hidden console).
    $win.Add_MouseLeftButtonDown({ try { $script:launcherWin.DragMove() } catch {} })
    $win.Add_Loaded({ $script:launcherWin.Activate() })
    if (Test-Path $script:IconPath) {
        try { $win.Icon = [System.Windows.Media.Imaging.BitmapFrame]::Create([Uri]$script:IconPath) } catch {}
    }
    return $win
}

function Show-LauncherDialog([bool]$running, [int]$port) {
    $script:launcherChoice = 'cancel'   # default; a button handler overwrites it, Esc/× leave it
    $win = New-LauncherWindow $running
    [void]$win.ShowDialog()
    return $script:launcherChoice
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
