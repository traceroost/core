; TraceRoost's NSIS hooks. electron-builder includes build/installer.nsh by name, ahead of its own
; templates, in both the installer and the uninstaller.
;
; customCheckAppRunning replaces electron-builder's "is the app running?" step, whose way of closing
; a running app is Stop-Process / taskkill — TerminateProcess, which runs no handler. That is the one
; thing an app-owned collector must not get: it would lose every span it had not flushed. So:
;
;   1. ask TraceRoost to quit itself: `traceroost-desktop.exe --quit` reaches the running instance
;      (src/windows.ts), which stops its collector with the owner channel's shutdown request, waits
;      for the flush, and exits;
;   2. wait (up to 30 s) for every process running from the install directory — the app and its
;      collector — to be gone;
;   3. then run electron-builder's own check unchanged, as the last resort for anything still there
;      (an older build without `--quit`, or a hung process).

!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 traceroost_check_default
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      DetailPrint "Asking TraceRoost to quit and save its data..."
      nsExec::Exec /TIMEOUT=15000 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit'
      Pop $R0
      StrCpy $R1 0
      traceroost_wait_for_quit:
        Sleep 1000
        IntOp $R1 $R1 + 1
        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
        ${andIf} $R1 < 30
          Goto traceroost_wait_for_quit
        ${endIf}
    ${endIf}
  traceroost_check_default:
  !insertmacro _CHECK_APP_RUNNING
!macroend
