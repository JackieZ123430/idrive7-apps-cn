<#
 push-to-car.ps1 - the Windows version of push-to-car.sh: copy the kit to the head unit over
 SSH and run a command there. Needs only Windows 10/11's own OpenSSH client (no WSL, Python
 or Node) and the SSH key from the idrive7-8-ssh-root tool.

   .\push-to-car.ps1 check   -Key <...\data\enrollments\<VIN>\id_rsa> [-Ip 169.254.36.47]
   .\push-to-car.ps1 install -Key <...>
   (also: status, restore)

 The kit is mgu-custom-apps.tar.gz (deploy/make-car-kit.sh), found next to this script or in
 ..\dist\, or given with -Kit. It lands in /var/opt/mgu-custom-apps on the unit, so its
 backups/ folder stays on the car. Blocked script? Run it as:
   powershell -ExecutionPolicy Bypass -File .\push-to-car.ps1 check -Key ...
#>
param(
    [Parameter(Position = 0)][ValidateSet('check', 'install', 'status', 'restore')][string]$Cmd = 'check',
    [Parameter(Mandatory = $true)][string]$Key,
    [string]$Ip = '169.254.36.47',
    [string]$Kit = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Kit) {
    foreach ($k in @((Join-Path $here 'mgu-custom-apps.tar.gz'), (Join-Path $here '..\dist\mgu-custom-apps.tar.gz'))) {
        if (Test-Path $k) { $Kit = $k; break }
    }
}
if (-not $Kit -or -not (Test-Path $Kit)) { throw 'mgu-custom-apps.tar.gz not found: put it next to this script, or give -Kit <path>' }
if (-not (Test-Path $Key)) { throw "SSH key not found: $Key" }
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { throw 'ssh not found: Settings > Apps > Optional features > add "OpenSSH Client"' }
$Kit = (Resolve-Path $Kit).Path
$Key = (Resolve-Path $Key).Path

# the same options the SSH tool uses: the car's host key changes with every flash, so never pin it
$opts = @('-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL',
    '-o', 'GlobalKnownHostsFile=NUL', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR',
    '-i', $Key, "root@$Ip")
$dest = '/var/opt/mgu-custom-apps'

Write-Host "Copying the kit to the head unit ($Ip)..."
# the kit goes into ssh's stdin byte for byte (a PowerShell pipe would turn it into text);
# apps/ is replaced, not merged: old .mgu files left there would be installed too (old, then new)
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = (Get-Command ssh).Source
$psi.Arguments = (($opts | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ') +
    " ""mkdir -p $dest && rm -rf $dest/apps && tar xzf - -C /var/opt && cd $dest && md5sum -c KIT_SUMS >/dev/null && echo 'kit copied + verified'"""
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$p = [System.Diagnostics.Process]::Start($psi)
$in = [System.IO.File]::OpenRead($Kit)
try { $in.CopyTo($p.StandardInput.BaseStream) } finally { $in.Close(); $p.StandardInput.Close() }
$p.WaitForExit()
if ($p.ExitCode -ne 0) { throw "copying the kit failed (ssh exit $($p.ExitCode)). Is SSH open? Run the SSH tool's Enable first." }

# restore asks you to type YES, so it needs a terminal
$t = @(); if ($Cmd -eq 'restore') { $t = @('-t') }
& ssh @t @opts "cd $dest && sh deploy-car.sh $Cmd"
exit $LASTEXITCODE
