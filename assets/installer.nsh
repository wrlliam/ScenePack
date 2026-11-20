; Extra installer steps (electron-builder includes this automatically).
; Adds "Send to > ScenePack" to the right-click menu of files in Explorer, so videos can be queued in one click.
!macro customInstall
  CreateShortCut "$SENDTO\ScenePack.lnk" "$INSTDIR\ScenePack.exe" "" "$INSTDIR\ScenePack.exe" 0
!macroend

!macro customUnInstall
  Delete "$SENDTO\ScenePack.lnk"
!macroend
