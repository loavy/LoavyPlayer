# Loavy Player Installer Exit Codes

Loavy Player uses an NSIS EXE installer.

## Silent install

Use the following silent install parameter:

```powershell
/S
```

## Return codes

| Scenario | Return code |
| --- | ---: |
| Installation successful | `0` |
| Installation cancelled by user | `1` |
| Application already exists | `1638` |
| Installation already in progress | `1618` |
| Disk space is full | `112` |
| Reboot required | `3010` |
| Network failure | `12029` |
| Package rejected during installation | `5` |
