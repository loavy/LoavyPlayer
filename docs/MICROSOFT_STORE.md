# Microsoft Store publishing checklist

Loavy Player uses Tauri v2 and publishes a conventional Windows NSIS installer. This guide prepares the x64 EXE installer for Microsoft Store submission; it does not publish anything.

## Build the Store installer

Install dependencies, run the checks, and build on a Windows x64 machine:

```powershell
npm install
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run desktop:store
```

If PowerShell blocks `npm.ps1`, use the equivalent `npm.cmd` commands, for example:

```powershell
npm.cmd run desktop:store
```

`desktop:store` merges `src-tauri/tauri.microsoftstore.conf.json` into the normal Tauri configuration and builds only the existing preferred NSIS target. The Store override embeds the offline WebView2 installer, so expect a much larger setup file. The exact size can change with WebView2 releases. This satisfies the requirement that the submitted installer be standalone rather than a web installer.

The generated x64 installer is:

```text
src-tauri/target/release/bundle/nsis/Loavy Player_<version>_x64-setup.exe
```

NSIS remains the release target for this repository. Do not submit the unpackaged `src-tauri/target/release/loavy-player.exe`.

## Silent installation

Use the following exact silent argument for the NSIS setup:

```text
/S
```

Example:

```powershell
& ".\Loavy Player_4.1.5_x64-setup.exe" /S
```

The existing NSIS hook detects silent mode and skips its optional Web Media Extensions prompt, so a Store-driven installation remains unattended.

For the current EXE submission, enter `/S` as the installer parameter.

## Package hosting

Partner Center requires an immutable, versioned, direct HTTPS URL for the installer. Do not use a GitHub Releases URL for the Store package: those URLs redirect, and Partner Center rejects them in the current submission flow.

Upload the signed, versioned NSIS EXE to the project's public Cloudflare R2 hosting and submit its direct public URL. Confirm that the URL requires no authentication, does not redirect, and downloads the exact submitted installer. Do not replace the file at that URL after submission; use a new versioned URL for each release.

## Release metadata audit

| Field | Current value | Release action |
| --- | --- | --- |
| Product and window name | `Loavy Player` | Keep aligned with the reserved Store product name. |
| Version | `4.1.5` | Keep `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` synchronized for each release. |
| Application identifier | `com.loavy.player` | Keep stable so upgrades and local app data continue to use the same identity. |
| Publisher / Manufacturer | `loavy` | Keep stable for upgrade compatibility. Tauri uses this value in the Windows registry to locate existing installations. |
| Application and installer icon | `src-tauri/icons/icon.ico` | Already configured for the app and NSIS installer and contains standard 16–256 px sizes. |
| Windows bundle target | NSIS, current-user install | Submit the current NSIS EXE target. |
| WebView2 mode | `offlineInstaller` in the Store override | Use `desktop:store`; the normal desktop build is intentionally unchanged. |

The Tauri Publisher/Manufacturer value is also part of the installer's upgrade identity. Existing Loavy Player releases used `loavy`, so changing it requires an explicit registry migration; do not rename it only for display purposes. The verified legal publisher in Partner Center and the Authenticode certificate must still use the owner's real identity. Signing settings are intentionally absent because the certificate thumbprint, timestamp service, or custom signing command must come from the actual certificate provider. Unsigned local installers are for build validation only. For the final Store submission, the installer and all included PE files must be Authenticode-signed with a certificate that chains to the Microsoft Trusted Root Program.

## Partner Center submission

- [ ] Create or sign in to the Windows developer account in Partner Center.
- [ ] Select **New product → EXE or MSI app** and reserve/confirm the `Loavy Player` product name.
- [ ] Confirm the Partner Center and signing-certificate publisher identity. Keep Tauri's `bundle.publisher` as `loavy` unless a tested registry migration is added for existing users.
- [ ] Configure Authenticode signing and sign the installer and included PE binaries with a certificate that chains to the Microsoft Trusted Root Program.
- [ ] Run `npm run desktop:store` on the release commit and retain its logs.
- [ ] Test install, launch, upgrade, and uninstall on clean Windows 10 and Windows 11 machines. Test the NSIS installer with `/S`.
- [ ] Upload the signed installer to a versioned path in the public Cloudflare R2 hosting. Verify that its direct HTTPS URL does not redirect, and do not replace the file at that URL after submission.
- [ ] In the Packages section, add/upload the installer using that package URL and select **EXE**, **x64**, the supported language, and installer parameter `/S`.
- [ ] Complete pricing, availability, category, age-rating, support-contact, system-requirement, and certification-notes fields.
- [ ] Add Store listing text, a required square Store logo, and screenshots. Partner Center requires at least 1 screenshot, recommends 4 or more, and allows up to 10. Suggested captures are Songs/library, Now Playing, Folders, Settings, and Room/Jam.
- [ ] Review [`PRIVACY.md`](../PRIVACY.md), replace its contact placeholder, publish it at a stable public HTTPS URL, and enter the required privacy policy URL in Partner Center. The policy covers local library scanning, optional metadata providers, downloads, and optional Room/Jam networking.
- [ ] In the privacy/data-access declaration, accurately disclose metadata lookups and peer-to-peer Room/Jam transfers even though Loavy Player has no central room service.
- [ ] Verify the installer URL, SHA-256 hash, signature, version, silent argument, screenshots, privacy URL, and support details one final time.
- [ ] Submit the completed product for Microsoft certification.

## Relevant official documentation

- [Microsoft: Create an MSI/EXE app submission](https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/create-app-submission)
- [Microsoft: Upload MSI/EXE app packages](https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/upload-app-packages)
- [Microsoft: MSI/EXE package requirements](https://learn.microsoft.com/windows/apps/publish/publish-your-app/msi/app-package-requirements)
- [Tauri: Windows installer and offline WebView2 mode](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri: Windows code signing](https://v2.tauri.app/distribute/sign/windows/)
