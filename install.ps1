# Installer for opencode-relay: clones the repository, builds it, and adds it
# to the OpenCode config.
#
# Safe under `irm <url> | iex`: there is no param() block, options come from
# $args or the environment, and no code path calls exit (errors throw or are
# reported and returned, so the calling shell keeps running).

function Get-RelayEnv {
    param([string]$Name, [string]$Fallback)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $Fallback }
    return $value
}

function Test-RelayFlag {
    param([string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    return @('1', 'true', 'yes', 'on') -contains $value.Trim().ToLowerInvariant()
}

function Show-RelayUsage {
    Write-Output 'Usage: install.ps1 [options]'
    Write-Output ''
    Write-Output 'Options:'
    Write-Output '  --no-config     install and build only; do not touch opencode.json'
    Write-Output '  --update        rebuild the existing checkout instead of cloning again'
    Write-Output '  -h, --help      show this help and exit'
    Write-Output ''
    Write-Output 'Environment:'
    Write-Output '  OPENCODE_RELAY_REPO       git repository to clone'
    Write-Output '                             (default: https://github.com/mahyartdb/opencode-relay.git)'
    Write-Output '  OPENCODE_RELAY_HOME       where the plugin is installed'
    Write-Output "                             (default: $HOME\.local\share\opencode-relay)"
    Write-Output '  OPENCODE_CONFIG_DIR       OpenCode config directory'
    Write-Output "                             (default: $HOME\.config\opencode)"
    Write-Output '  OPENCODE_RELAY_NO_CONFIG  set to 1 to skip writing the config'
    Write-Output '  OPENCODE_RELAY_UPDATE     set to 1 to update an existing installation'
}

function Show-RelaySnippet {
    param([string]$File, [string]$Plugin)
    Write-Output "Add this entry to ${File}:"
    Write-Output ''
    Write-Output '{'
    Write-Output ('  "plugin": ["{0}"]' -f $Plugin)
    Write-Output '}'
}

function Test-RelayCommand {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "install.ps1: $Name is required but was not found on PATH."
    }
}

function Assert-RelayStep {
    param([string]$What)
    if ($LASTEXITCODE -ne 0) {
        throw "install.ps1: $What failed with exit code $LASTEXITCODE."
    }
}

# Comments and trailing commas are not plain JSON. Windows PowerShell 5.1
# rejects them by itself, PowerShell 7's parser does not, so they are rejected
# here explicitly instead of being silently rewritten.
function Test-RelayPlainJson {
    param([string]$Text)
    $inString = $false
    $escaped = $false
    $length = $Text.Length
    for ($i = 0; $i -lt $length; $i++) {
        $ch = $Text[$i]
        if ($inString) {
            if ($escaped) { $escaped = $false }
            elseif ($ch -eq '\') { $escaped = $true }
            elseif ($ch -eq '"') { $inString = $false }
            continue
        }
        if ($ch -eq '"') { $inString = $true; continue }
        if ($ch -eq '/') {
            if (($i + 1) -lt $length -and ($Text[$i + 1] -eq '/' -or $Text[$i + 1] -eq '*')) {
                return $false
            }
        }
        if ($ch -eq ',') {
            $j = $i + 1
            while ($j -lt $length -and [char]::IsWhiteSpace($Text[$j])) { $j++ }
            if ($j -lt $length -and ($Text[$j] -eq '}' -or $Text[$j] -eq ']')) {
                return $false
            }
        }
    }
    return $true
}

# Emits JSON with two-space indentation on every supported PowerShell version
# (Windows PowerShell 5.1 indents with four spaces and pads array elements, so
# its own ConvertTo-Json output is not used for the layout).
function ConvertTo-RelayJson {
    param($Value, [int]$Level = 0)

    if ($null -eq $Value) { return 'null' }
    if ($Value -is [string]) { return (ConvertTo-Json -InputObject $Value -Compress) }

    $pad = '  ' * ($Level + 1)
    $close = '  ' * $Level

    if ($Value -is [System.Collections.IDictionary]) {
        $entries = New-Object System.Collections.Generic.List[string]
        foreach ($key in $Value.Keys) {
            $name = ConvertTo-Json -InputObject ([string]$key) -Compress
            $entries.Add($pad + $name + ': ' + (ConvertTo-RelayJson $Value[$key] ($Level + 1)))
        }
        if ($entries.Count -eq 0) { return '{}' }
        return "{`n" + ($entries -join ",`n") + "`n" + $close + '}'
    }

    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $props = @($Value.PSObject.Properties)
        if ($props.Count -eq 0) { return '{}' }
        $entries = New-Object System.Collections.Generic.List[string]
        foreach ($prop in $props) {
            $name = ConvertTo-Json -InputObject ([string]$prop.Name) -Compress
            $entries.Add($pad + $name + ': ' + (ConvertTo-RelayJson $prop.Value ($Level + 1)))
        }
        return "{`n" + ($entries -join ",`n") + "`n" + $close + '}'
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        $items = @($Value)
        if ($items.Count -eq 0) { return '[]' }
        $entries = New-Object System.Collections.Generic.List[string]
        foreach ($item in $items) {
            $entries.Add($pad + (ConvertTo-RelayJson $item ($Level + 1)))
        }
        return "[`n" + ($entries -join ",`n") + "`n" + $close + ']'
    }

    return (ConvertTo-Json -InputObject $Value -Compress)
}

$relayRepo = Get-RelayEnv 'OPENCODE_RELAY_REPO' 'https://github.com/mahyartdb/opencode-relay.git'
$relayHome = Get-RelayEnv 'OPENCODE_RELAY_HOME' (Join-Path $HOME '.local\share\opencode-relay')
$configDir = Get-RelayEnv 'OPENCODE_CONFIG_DIR' (Join-Path $HOME '.config\opencode')
$noConfig = Test-RelayFlag 'OPENCODE_RELAY_NO_CONFIG'
$update = Test-RelayFlag 'OPENCODE_RELAY_UPDATE'

foreach ($relayArg in @($args)) {
    if ($relayArg -eq '--no-config') {
        $noConfig = $true
    } elseif ($relayArg -eq '--update') {
        $update = $true
    } elseif ($relayArg -eq '-h' -or $relayArg -eq '--help') {
        Show-RelayUsage
        return
    } else {
        Write-Error "install.ps1: unknown argument: $relayArg"
        Show-RelayUsage
        return
    }
}

if (-not [IO.Path]::IsPathRooted($relayHome)) {
    $relayHome = Join-Path (Get-Location).Path $relayHome
}
$relayHome = [IO.Path]::GetFullPath($relayHome)
$configFile = Join-Path $configDir 'opencode.json'

Test-RelayCommand 'bun'
$bunVersion = & bun --version
Assert-RelayStep 'bun --version'
Write-Output "Found bun $bunVersion"

if ($update) {
    Test-RelayCommand 'git'
    if (-not (Test-Path -LiteralPath (Join-Path $relayHome '.git'))) {
        throw "install.ps1: --update needs an existing clone at $relayHome. Run this installer without --update to clone it first."
    }
    Write-Output "Updating $relayHome ..."
    Push-Location $relayHome
    try {
        git pull --ff-only
        Assert-RelayStep 'git pull'
    } finally {
        Pop-Location
    }
} elseif (Test-Path -LiteralPath (Join-Path $relayHome '.git')) {
    Write-Output "Found an existing clone at $relayHome; rebuilding it."
} elseif (Test-Path -LiteralPath $relayHome) {
    throw "install.ps1: $relayHome exists but is not a git clone. Remove it or set OPENCODE_RELAY_HOME to another directory."
} else {
    Test-RelayCommand 'git'
    $relayParent = Split-Path -Parent $relayHome
    if ($relayParent -and -not (Test-Path -LiteralPath $relayParent)) {
        New-Item -ItemType Directory -Force -Path $relayParent | Out-Null
    }
    Write-Output "Cloning $relayRepo into $relayHome ..."
    git clone --depth 1 $relayRepo $relayHome
    Assert-RelayStep 'git clone'
}

Write-Output 'Installing dependencies ...'
Push-Location $relayHome
try {
    bun install --frozen-lockfile
    Assert-RelayStep 'bun install'
    Write-Output 'Building ...'
    bun run build
    Assert-RelayStep 'bun run build'
} finally {
    Pop-Location
}

$plugin = 'file:///' + (($relayHome -replace '\\', '/').TrimStart('/'))

if ($noConfig) {
    Write-Output 'Skipping the OpenCode config (--no-config).'
    Show-RelaySnippet -File $configFile -Plugin $plugin
    Write-Output ''
    Write-Output 'Done. Restart OpenCode to load the plugin.'
    return
}

if (-not (Test-Path -LiteralPath $configFile)) {
    $configParent = Split-Path -Parent $configFile
    if ($configParent -and -not (Test-Path -LiteralPath $configParent)) {
        New-Item -ItemType Directory -Force -Path $configParent | Out-Null
    }
    $configObject = [pscustomobject]@{ plugin = @($plugin) }
    $text = (ConvertTo-RelayJson $configObject) + "`n"
    [IO.File]::WriteAllText($configFile, $text, (New-Object System.Text.UTF8Encoding($false)))
    Write-Output "Created $configFile."
} else {
    Write-Output "Updating $configFile ..."
    $raw = $null
    $config = $null
    $parsed = $false
    try {
        $raw = [IO.File]::ReadAllText($configFile)
        if (Test-RelayPlainJson $raw) {
            $config = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
            $parsed = $true
        }
    } catch {
        $parsed = $false
    }

    if (-not $parsed) {
        Write-Error "install.ps1: $configFile cannot be parsed as plain JSON; leaving it untouched."
        Show-RelaySnippet -File $configFile -Plugin $plugin
        return
    }

    $isObject = $null -ne $config -and (
        $config -is [System.Management.Automation.PSCustomObject] -or
        $config -is [System.Collections.IDictionary]
    )
    if (-not $isObject) {
        Write-Error "install.ps1: $configFile is not a JSON object; leaving it untouched."
        Show-RelaySnippet -File $configFile -Plugin $plugin
        return
    }

    $plugins = $null
    $hasPluginList = $false
    if ($config -is [System.Collections.IDictionary]) {
        $hasPluginList = $config.Contains('plugin')
        if ($hasPluginList) { $plugins = $config['plugin'] }
    } else {
        $property = $config.PSObject.Properties['plugin']
        $hasPluginList = $null -ne $property
        if ($hasPluginList) { $plugins = $property.Value }
    }

    if ($hasPluginList -and -not ($plugins -is [array])) {
        Write-Error "install.ps1: the plugin entry in $configFile is not a list; leaving it untouched."
        Show-RelaySnippet -File $configFile -Plugin $plugin
        return
    }

    $appended = $false
    if (-not $hasPluginList) {
        if ($config -is [System.Collections.IDictionary]) {
            $config['plugin'] = @($plugin)
        } else {
            $config | Add-Member -NotePropertyName 'plugin' -NotePropertyValue @($plugin)
        }
        $appended = $true
    } elseif (@($plugins) -cnotcontains $plugin) {
        $merged = @($plugins) + @($plugin)
        if ($config -is [System.Collections.IDictionary]) {
            $config['plugin'] = $merged
        } else {
            $config.plugin = $merged
        }
        $appended = $true
    } else {
        Write-Output "$configFile already lists the plugin; rewriting it unchanged."
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$configFile.bak-$stamp"
    Copy-Item -LiteralPath $configFile -Destination $backup
    Write-Output "Backed up the previous config to $backup"
    $text = (ConvertTo-RelayJson $config) + "`n"
    [IO.File]::WriteAllText($configFile, $text, (New-Object System.Text.UTF8Encoding($false)))
    if ($appended) {
        Write-Output "Added the plugin to $configFile."
    } else {
        Write-Output "Rewrote $configFile without adding a duplicate."
    }
}

Write-Output ''
Write-Output 'Done. Restart OpenCode to load the plugin.'
