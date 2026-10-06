Option Explicit

Dim mode, command, shell, exitCode

If WScript.Arguments.Count <> 1 Then
  WScript.Quit 64
End If

mode = LCase(WScript.Arguments(0))

Select Case mode
  Case "watchdog"
    command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""F:\explore\pi-hub\scripts\pi-hub-watchdog.ps1"""
  Case "server"
    command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""F:\explore\pi-hub\scripts\pi-hub-server.ps1"""
  Case Else
    WScript.Quit 64
End Select

Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "F:\explore\pi-hub"
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
