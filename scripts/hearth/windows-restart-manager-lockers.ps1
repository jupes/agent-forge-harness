param([Parameter(ValueFromRemainingArguments = $true)][string[]] $ResourcePaths)
$ErrorActionPreference = 'Stop'
if ($ResourcePaths.Count -lt 1 -or $ResourcePaths.Count -gt 8) { exit 2 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ForgeRestartManager {
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess {
    public int ProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME StartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string ApplicationName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string ServiceName;
    public int ApplicationType;
    public uint ApplicationStatus;
    public uint TerminalSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(uint handle, uint fileCount, string[] files,
      uint appCount, IntPtr apps, uint serviceCount, IntPtr services);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint handle, out uint needed, ref uint count,
      [In, Out] ProcessInfo[] processes, out uint rebootReasons);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint handle);
}
'@
$key = New-Object System.Text.StringBuilder 33
$handle = 0
$code = [ForgeRestartManager]::RmStartSession([ref]$handle, 0, $key)
if ($code -ne 0) { exit 3 }
try {
  $code = [ForgeRestartManager]::RmRegisterResources($handle, [uint32]$ResourcePaths.Count,
      $ResourcePaths, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero)
  if ($code -ne 0) { exit 4 }
  [uint32]$needed = 0
  [uint32]$count = 0
  [uint32]$reasons = 0
  $code = [ForgeRestartManager]::RmGetList($handle, [ref]$needed, [ref]$count, $null, [ref]$reasons)
  if ($code -eq 234 -and $needed -gt 0 -and $needed -le 256) {
    $items = New-Object 'ForgeRestartManager+ProcessInfo[]' $needed
    $count = $needed
    $code = [ForgeRestartManager]::RmGetList($handle, [ref]$needed, [ref]$count, $items, [ref]$reasons)
    if ($code -eq 0) {
      @($items | Select-Object -First $count | ForEach-Object { $_.Process.ProcessId } | Sort-Object -Unique) | ConvertTo-Json -Compress
      exit 0
    }
  } elseif ($code -eq 0) {
    '[]'
    exit 0
  }
  exit 5
} finally {
  [void][ForgeRestartManager]::RmEndSession($handle)
}
