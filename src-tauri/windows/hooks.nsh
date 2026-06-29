Var InstallMediaTools

!macro NSIS_HOOK_PREINSTALL
  IfSilent tools_skip_prompt 0
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Install optional Tools?$\\r$\\n$\\r$\\nTools opens the Microsoft Web Media Extensions installer after Loavy Player is installed. It adds Windows support for OGG, Opus, and related web audio formats.$\\r$\\n$\\r$\\nYou can skip this and install it later." \
    IDYES tools_yes IDNO tools_no

  tools_yes:
    StrCpy $InstallMediaTools "1"
    Goto tools_choice_done

  tools_no:
    StrCpy $InstallMediaTools "0"
    Goto tools_choice_done

  tools_skip_prompt:
    StrCpy $InstallMediaTools "0"

  tools_choice_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  StrCmp $InstallMediaTools "1" 0 tools_post_done
  ExecShell "open" "ms-windows-store://pdp/?ProductId=9N5TDP8VCMHS"

  tools_post_done:
!macroend
