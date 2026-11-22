; Equavela installer hooks (included by windows/installer.nsi through installerHooks).

; Undo APP_ASSOCIATE (Tauri's FileAssociation.nsh) without leaving debris and
; without touching a file type another program has taken over since.
;  - the ".ext" default value is restored only while it still names our class;
;  - the "<class>_backup" value is always removed;
;  - the ".ext" key is deleted only when it is then empty;
;  - our class key is always deleted.
!macro EQUAVELA_UNASSOCIATE EXT FILECLASS
  ReadRegStr $R0 SHELL_CONTEXT "Software\Classes\.${EXT}" ""
  ReadRegStr $R1 SHELL_CONTEXT "Software\Classes\.${EXT}" "${FILECLASS}_backup"
  ${If} $R0 == "${FILECLASS}"
    ${If} $R1 == ""
    ${OrIf} $R1 == "${FILECLASS}"
      DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" ""
    ${Else}
      WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "$R1"
    ${EndIf}
  ${EndIf}
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}" "${FILECLASS}_backup"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${FILECLASS}"
!macroend

; The install location is not user data: remove it on a real uninstall (the
; stock template keeps it unless "delete app data" is ticked). The vendor key
; goes only when empty, so other products of the same vendor are safe.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"
  ${EndIf}
!macroend
