use std::{fs, path::Path, path::PathBuf};

#[cfg(unix)]
use std::process::Command;

use anyhow::{bail, Context, Result};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExistingPathKind {
    File,
    Directory,
}

/// Opens an existing directory in the platform file manager, or opens the
/// parent directory with an existing file selected.
///
/// The path is canonicalized before it crosses the platform boundary. This
/// avoids passing a relative or ambiguous path to the shell and makes missing
/// path errors deterministic.
pub fn reveal_existing_path(path: &Path) -> Result<()> {
    let (canonical, kind) = validate_existing_path(path)?;
    platform_reveal(&canonical, kind)
}

fn validate_existing_path(path: &Path) -> Result<(PathBuf, ExistingPathKind)> {
    let canonical = path.canonicalize().with_context(|| {
        format!(
            "The requested path does not exist or cannot be accessed: {}",
            path.display()
        )
    })?;
    let metadata = fs::metadata(&canonical).with_context(|| {
        format!(
            "Could not inspect the resolved path: {}",
            canonical.display()
        )
    })?;

    let kind = if metadata.is_file() {
        ExistingPathKind::File
    } else if metadata.is_dir() {
        ExistingPathKind::Directory
    } else {
        bail!(
            "The requested path is neither a regular file nor a directory: {}",
            canonical.display()
        );
    };

    Ok((canonical, kind))
}

#[cfg(target_os = "windows")]
fn platform_reveal(path: &Path, kind: ExistingPathKind) -> Result<()> {
    match kind {
        ExistingPathKind::File => windows_impl::select_file(path),
        ExistingPathKind::Directory => windows_impl::open_directory(path),
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path, ptr};

    use anyhow::{anyhow, Context, Result};
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::RPC_E_CHANGED_MODE,
            System::Com::{
                CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED,
            },
            UI::{
                Shell::{
                    Common::ITEMIDLIST, SHOpenFolderAndSelectItems, SHParseDisplayName,
                    ShellExecuteW,
                },
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
    };

    struct ComApartment {
        uninitialize: bool,
    }

    impl ComApartment {
        fn initialize() -> Result<Self> {
            // SAFETY: A null reserved pointer is required by CoInitializeEx. A
            // successful call is balanced by this guard's Drop implementation.
            let result = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if result.is_ok() {
                Ok(Self { uninitialize: true })
            } else if result == RPC_E_CHANGED_MODE {
                // The calling thread already has a different COM apartment.
                // Shell APIs can still use it, but this call did not acquire a
                // COM initialization reference and therefore must not uninit it.
                Ok(Self {
                    uninitialize: false,
                })
            } else {
                Err(anyhow!(
                    "Could not initialize Windows Explorer integration (HRESULT {result:?})."
                ))
            }
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.uninitialize {
                // SAFETY: This balances the successful CoInitializeEx call on
                // the same thread where the guard was created and dropped.
                unsafe { CoUninitialize() };
            }
        }
    }

    struct ShellItemId(*mut ITEMIDLIST);

    impl Drop for ShellItemId {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: SHParseDisplayName allocates this PIDL with the COM
                // task allocator, so CoTaskMemFree is its required deallocator.
                unsafe { CoTaskMemFree(Some(self.0.cast())) };
            }
        }
    }

    pub(super) fn select_file(path: &Path) -> Result<()> {
        let _apartment = ComApartment::initialize()?;
        let wide_path = shell_path_wide(path);
        let mut raw_item_id = ptr::null_mut();

        // SAFETY: wide_path is NUL-terminated for the duration of the call;
        // raw_item_id points to writable storage owned by this stack frame.
        let parse_result = unsafe {
            SHParseDisplayName(
                PCWSTR(wide_path.as_ptr()),
                None::<&IBindCtx>,
                &mut raw_item_id,
                0,
                None,
            )
        };
        // Install the guard before propagating a parse error: although the API
        // normally leaves a null out-pointer on failure, freeing a partial PIDL
        // here also covers defensive/implementation-specific behavior.
        let item_id = ShellItemId(raw_item_id);
        parse_result
            .with_context(|| format!("Windows Explorer could not resolve {}.", path.display()))?;

        if item_id.0.is_null() {
            return Err(anyhow!(
                "Windows Explorer resolved an empty item for {}.",
                path.display()
            ));
        }

        // Passing the full item PIDL with no child PIDL array is the documented
        // cidl=0 form: Explorer opens the parent and selects this exact item.
        // It avoids command-line tokenization bugs for commas, ampersands,
        // apostrophes, spaces, and Unicode file names.
        // SAFETY: item_id remains valid until after the call returns.
        unsafe { SHOpenFolderAndSelectItems(item_id.0, None, 0) }
            .with_context(|| format!("Windows Explorer could not select {}.", path.display()))
    }

    pub(super) fn open_directory(path: &Path) -> Result<()> {
        let operation = wide_null(OsStr::new("open"));
        let wide_path = shell_path_wide(path);

        // SAFETY: All PCWSTR values either refer to NUL-terminated buffers that
        // remain live through the call or are explicit null pointers.
        let result = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(operation.as_ptr()),
                PCWSTR(wide_path.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        let result_code = result.0 as isize;
        if result_code <= 32 {
            return Err(anyhow!(
                "Windows Explorer could not open {} (ShellExecuteW code {result_code}).",
                path.display()
            ));
        }
        Ok(())
    }

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn shell_path_wide(path: &Path) -> Vec<u16> {
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();

        // std::fs::canonicalize commonly returns verbatim paths on Windows.
        // Shell namespace parsing expects a conventional drive/UNC path. Strip
        // only the two forms for which the transformation is lossless, while
        // retaining the original UTF-16 code units exactly.
        const VERBATIM: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
        const VERBATIM_UNC: &[u16] = &[
            b'\\' as u16,
            b'\\' as u16,
            b'?' as u16,
            b'\\' as u16,
            b'U' as u16,
            b'N' as u16,
            b'C' as u16,
            b'\\' as u16,
        ];

        if wide.starts_with(VERBATIM_UNC) {
            wide.splice(..VERBATIM_UNC.len(), [b'\\' as u16, b'\\' as u16]);
        } else if wide.starts_with(VERBATIM)
            && wide.get(5) == Some(&(b':' as u16))
            && wide
                .get(4)
                .is_some_and(|unit| (*unit as u8).is_ascii_alphabetic())
        {
            wide.drain(..VERBATIM.len());
        }

        wide.push(0);
        wide
    }

    #[cfg(test)]
    mod tests {
        use std::{ffi::OsString, os::windows::ffi::OsStringExt, path::Path};

        use super::shell_path_wide;

        #[test]
        fn shell_path_preserves_special_utf16_characters() {
            let path = Path::new(r"C:\Music\Beyoncé, R&B's – 音楽.mp3");
            let wide = shell_path_wide(path);
            let round_trip = OsString::from_wide(&wide[..wide.len() - 1]);
            assert_eq!(round_trip, path.as_os_str());
        }

        #[test]
        fn shell_path_strips_verbatim_drive_prefix() {
            let path = Path::new(r"\\?\C:\Music\Track.mp3");
            let wide = shell_path_wide(path);
            let round_trip = OsString::from_wide(&wide[..wide.len() - 1]);
            assert_eq!(round_trip, OsString::from(r"C:\Music\Track.mp3"));
        }

        #[test]
        fn shell_path_converts_verbatim_unc_prefix() {
            let path = Path::new(r"\\?\UNC\server\share\Track.mp3");
            let wide = shell_path_wide(path);
            let round_trip = OsString::from_wide(&wide[..wide.len() - 1]);
            assert_eq!(round_trip, OsString::from(r"\\server\share\Track.mp3"));
        }
    }
}

#[cfg(target_os = "macos")]
fn platform_reveal(path: &Path, kind: ExistingPathKind) -> Result<()> {
    let mut command = Command::new("open");
    if kind == ExistingPathKind::File {
        command.arg("-R");
    }
    command
        .arg(path)
        .spawn()
        .with_context(|| format!("Could not open Finder for {}.", path.display()))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_reveal(path: &Path, kind: ExistingPathKind) -> Result<()> {
    let destination = match kind {
        ExistingPathKind::File => path.parent().unwrap_or(path),
        ExistingPathKind::Directory => path,
    };
    Command::new("xdg-open")
        .arg(destination)
        .spawn()
        .with_context(|| {
            format!(
                "Could not open the file manager for {}.",
                destination.display()
            )
        })?;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
fn platform_reveal(path: &Path, _kind: ExistingPathKind) -> Result<()> {
    bail!(
        "Opening the system file manager is not supported on this platform for {}.",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{validate_existing_path, ExistingPathKind};

    fn unique_test_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "loavy-explorer-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn missing_path_returns_a_useful_error() {
        let missing = unique_test_path("missing").join("does-not-exist.mp3");
        let error = validate_existing_path(&missing).expect_err("missing paths must be rejected");
        let message = format!("{error:#}");
        assert!(message.contains("does not exist or cannot be accessed"));
        assert!(message.contains("does-not-exist.mp3"));
    }

    #[test]
    fn canonicalization_preserves_special_character_file_name() {
        let root = unique_test_path("special");
        fs::create_dir_all(&root).expect("temporary test directory should be created");
        let file_name = "Beyoncé, R&B's – ação 音楽.mp3";
        let file = root.join(file_name);
        fs::write(&file, b"test").expect("temporary test file should be created");

        let result = validate_existing_path(&file);
        fs::remove_dir_all(&root).expect("temporary test directory should be removed");

        let (canonical, kind) = result.expect("special-character path should validate");
        assert_eq!(kind, ExistingPathKind::File);
        assert_eq!(
            canonical.file_name().and_then(|value| value.to_str()),
            Some(file_name)
        );
        assert!(canonical.is_absolute());
    }

    #[test]
    fn canonicalization_identifies_a_directory() {
        let root = unique_test_path("directory");
        fs::create_dir_all(&root).expect("temporary test directory should be created");

        let result = validate_existing_path(&root);
        fs::remove_dir_all(&root).expect("temporary test directory should be removed");

        let (canonical, kind) = result.expect("existing directory should validate");
        assert_eq!(kind, ExistingPathKind::Directory);
        assert!(canonical.is_absolute());
    }
}
