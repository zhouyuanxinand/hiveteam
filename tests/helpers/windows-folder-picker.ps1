param(
  [Parameter(Mandatory=$true)][int]$PickerProcessId,
  [Parameter(Mandatory=$true)][ValidateSet('cancel', 'select')][string]$Action
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeFolderPickerTest {
  public delegate bool Callback(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr handle, int id);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr handle, uint command);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr handle, int index);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
  public static IntPtr FindDialog(uint targetProcessId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((handle, p) => {
      uint processId; GetWindowThreadProcessId(handle, out processId);
      if (processId != targetProcessId || !IsWindowVisible(handle)) return true;
      var name = new StringBuilder(256); GetClassName(handle, name, name.Capacity);
      if (name.ToString() == "#32770") { found=handle; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int ZOrder(IntPtr target) {
    int index = 0, found = -1;
    EnumWindows((handle, p) => {
      if (handle == target) { found=index; return false; }
      index++; return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

# A normal top-level window exercises the same Windows stacking rule as a browser.
# Raising it after the picker opens makes the background-dialog bug deterministic.
$fixture = New-Object System.Windows.Forms.Form
$fixture.Text = 'Hive folder picker integration check'
$fixture.ShowInTaskbar = $false
$fixture.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$fixture.Size = New-Object System.Drawing.Size(800, 650)
$dialogHandle = [IntPtr]::Zero
try {
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ($dialogHandle -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $deadline) {
    $dialogHandle = [NativeFolderPickerTest]::FindDialog($PickerProcessId)
    Start-Sleep -Milliseconds 50
  }
  if ($dialogHandle -eq [IntPtr]::Zero) { throw 'The real folder picker did not open.' }
  $ownerHandle = [NativeFolderPickerTest]::GetWindow($dialogHandle, 4)
  $fixture.Show()
  [System.Windows.Forms.Application]::DoEvents()
  [void][NativeFolderPickerTest]::SetWindowPos($fixture.Handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x13)
  Start-Sleep -Milliseconds 150
  $pickerZ = [NativeFolderPickerTest]::ZOrder($dialogHandle)
  $fixtureZ = [NativeFolderPickerTest]::ZOrder($fixture.Handle)
  $aboveNormalWindow = $pickerZ -ge 0 -and $pickerZ -lt $fixtureZ
  $ownerTopMost = ([NativeFolderPickerTest]::GetWindowLong($ownerHandle, -20) -band 8) -ne 0
  [void][NativeFolderPickerTest]::SetForegroundWindow($dialogHandle)
  $buttonId = if ($Action -eq 'select') { 1 } else { 2 }
  $button = [NativeFolderPickerTest]::GetDlgItem($dialogHandle, $buttonId)
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [NativeFolderPickerTest]::IsWindowEnabled($button) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 50
  }
  if (-not [NativeFolderPickerTest]::IsWindowEnabled($button)) { throw 'The native picker button did not become enabled.' }
  [void][NativeFolderPickerTest]::PostMessage($button, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero)
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while (([NativeFolderPickerTest]::IsWindow($dialogHandle) -or [NativeFolderPickerTest]::IsWindow($ownerHandle)) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 50
  }
  [pscustomobject]@{
    aboveNormalWindow = $aboveNormalWindow
    ownerTopMost = $ownerTopMost
    dialogClosed = -not [NativeFolderPickerTest]::IsWindow($dialogHandle)
    ownerClosed = -not [NativeFolderPickerTest]::IsWindow($ownerHandle)
  } | ConvertTo-Json -Compress
} finally {
  if ($dialogHandle -ne [IntPtr]::Zero -and [NativeFolderPickerTest]::IsWindow($dialogHandle)) {
    [void][NativeFolderPickerTest]::PostMessage($dialogHandle, 0x111, [IntPtr]2, [IntPtr]::Zero)
  }
  $fixture.Dispose()
}
