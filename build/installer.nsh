; インストーラが PATH を通す（2026-10-11）。`code .` と同じく `panedeck .` で起動できるように。
; 中身は build/path-entry.ps1（試験は tests/unit/path-entry.spec.ts）。
; 文字列の上限で PATH を切り詰める事故を避けるため、NSIS 側では PATH を読み書きしない

!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\path-entry.ps1" -Action add -Dir "$INSTDIR"'
!macroend

!macro customUnInstall
  ; 上書きインストールの途中で呼ばれたときは外さない（新しい版がすぐ足し直すが、その間に失敗すると消えたままになる）
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\path-entry.ps1" -Action remove -Dir "$INSTDIR"'
  ${endIf}
!macroend