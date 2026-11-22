//! Native WebView2 settings for keyboard shortcuts owned by the application.

use tauri::WebviewWindow;

/// The variable that gives a developer of Equavela the WebView2 developer tools.
pub const DEVTOOLS_VARIABLE: &str = "EQUAVELA_DEVTOOLS";

/// Whether the developer tools are on: only in a debug build, and only on purpose with
/// [`DEVTOOLS_VARIABLE`]. A release build never has them.
pub fn developer_access(debug_build: bool, variable: Option<&std::ffi::OsStr>) -> bool {
    debug_build && variable.is_some()
}

/// Keep WebView2 from consuming browser accelerators before DOM handlers can handle them.
///
/// The app's keymap and standard editor shortcuts remain handled by the web content. Disabling
/// WebView2's browser accelerator handling prevents shortcuts such as Ctrl+Shift+I from opening
/// browser tools instead of reaching the worksheet.
pub fn configure(window: &WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|webview| {
        let result = (|| -> Result<(), String> {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
            use windows::core::Interface;

            let controller = webview.controller();
            let core = unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
            let settings = unsafe { core.Settings() }.map_err(|error| error.to_string())?;

            // The Tauri config already disables DevTools. Apply the native settings too so neither a
            // browser accelerator nor the native context menu (Inspect) can expose them. A
            // debug build started with EQUAVELA_DEVTOOLS opens them for a developer.
            let developer = developer_access(
                cfg!(debug_assertions),
                std::env::var_os(DEVTOOLS_VARIABLE).as_deref(),
            );
            unsafe { settings.SetAreDevToolsEnabled(developer) }
                .map_err(|error| format!("could not set WebView2 DevTools: {error}"))?;
            unsafe { settings.SetAreDefaultContextMenusEnabled(developer) }
                .map_err(|error| format!("could not set the WebView2 context menu: {error}"))?;

            let settings3: ICoreWebView2Settings3 = settings.cast().map_err(|error| {
                format!("could not access WebView2 accelerator settings: {error}")
            })?;
            unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) }.map_err(|error| {
                format!("could not disable WebView2 browser accelerators: {error}")
            })?;

            // Paste from a menu or the ribbon reads the clipboard with the async clipboard API. WebView2
            // asks the user for that permission and, in this window, the question never shows: the read
            // stays pending and Paste does nothing (GitHub ). The window only shows the
            // application's own pages, so reading the clipboard is allowed; no other permission is.
            let handler =
                webview2_com::PermissionRequestedEventHandler::create(Box::new(|_, args| {
                    use webview2_com::Microsoft::Web::WebView2::Win32::{
                        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
                        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                    };
                    if let Some(args) = args {
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        unsafe { args.PermissionKind(&mut kind)? };
                        if kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ {
                            unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
                        }
                    }
                    Ok(())
                }));
            let mut token = 0;
            unsafe { core.add_PermissionRequested(&handler, &mut token) }
                .map_err(|error| format!("could not allow clipboard reads: {error}"))?;
            if developer {
                unsafe { core.OpenDevToolsWindow() }
                    .map_err(|error| format!("could not open the WebView2 DevTools: {error}"))?;
            }
            Ok(())
        })();

        if let Err(error) = result {
            eprintln!("Equavela: failed to configure WebView2 keyboard shortcuts: {error}");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::developer_access;
    use std::ffi::OsStr;

    /// the developer tools need a debug build and the variable.
    #[test]
    fn developer_tools_need_a_debug_build_and_the_variable() {
        assert!(developer_access(true, Some(OsStr::new("1"))));
        assert!(!developer_access(true, None));
        assert!(!developer_access(false, Some(OsStr::new("1"))));
        assert!(!developer_access(false, None));
    }
}
