//! The physical Ctrl key on Windows. AltGr arrives as Left Ctrl + Right Alt, so the web view cannot
//! tell `Ctrl+AltGr+è` (the shortcut of `[`) from `AltGr+è` (the character `[`). A low-level
//! keyboard hook sees every key before the web view: the Left Ctrl that AltGr synthesizes carries
//! the scan code `0x21D`, the real ones do not. The state goes to the frontend as the `real-ctrl`
//! event whenever it changes. Linux needs none of this: AltGr is not Ctrl there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL,
};

pub const EVENT_REAL_CTRL: &str = "real-ctrl";

const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
/// The scan code of the Left Ctrl that AltGr synthesizes.
const ALTGR_CTRL_SCAN: u32 = 0x21D;
const WM_KEYDOWN: usize = 0x100;
const WM_KEYUP: usize = 0x101;
const WM_SYSKEYDOWN: usize = 0x104;
const WM_SYSKEYUP: usize = 0x105;

static LEFT: AtomicBool = AtomicBool::new(false);
static RIGHT: AtomicBool = AtomicBool::new(false);
static NOTIFY: OnceLock<Box<dyn Fn(bool) + Send + Sync>> = OnceLock::new();

/// Starts the hook on a thread of its own; `notify` receives the real Ctrl state on every change.
pub fn start(notify: impl Fn(bool) + Send + Sync + 'static) {
    if NOTIFY.set(Box::new(notify)).is_err() {
        return;
    }
    std::thread::spawn(|| unsafe {
        if SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), None, 0).is_err() {
            return;
        }
        // A low-level hook runs on the thread that installed it, inside its message loop.
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {}
    });
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        // SAFETY: for a low-level keyboard hook, `lparam` points to the event's KBDLLHOOKSTRUCT.
        let info = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let down = match wparam.0 {
            WM_KEYDOWN | WM_SYSKEYDOWN => Some(true),
            WM_KEYUP | WM_SYSKEYUP => Some(false),
            _ => None,
        };
        let side = match info.vkCode {
            VK_LCONTROL if info.scanCode != ALTGR_CTRL_SCAN => Some(&LEFT),
            VK_RCONTROL => Some(&RIGHT),
            _ => None,
        };
        if let (Some(down), Some(side)) = (down, side) {
            let before = LEFT.load(Ordering::Relaxed) || RIGHT.load(Ordering::Relaxed);
            side.store(down, Ordering::Relaxed);
            let after = LEFT.load(Ordering::Relaxed) || RIGHT.load(Ordering::Relaxed);
            if before != after {
                if let Some(notify) = NOTIFY.get() {
                    notify(after);
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
