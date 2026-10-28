// Keep the logo in color; only recolor counters and badges for the taskbar theme.
#[cfg(any(target_os = "windows", test))]
pub(crate) fn colorize(mut rgba: Vec<u8>, width: usize, dark_taskbar: bool) -> Vec<u8> {
    let foreground = if dark_taskbar { 255 } else { 0 };
    for (index, pixel) in rgba.chunks_exact_mut(4).enumerate() {
        let x = index % width;
        let y = index / width;
        if x >= 36 || (width == 36 && (26..32).contains(&x) && (4..10).contains(&y)) {
            pixel[..3].fill(foreground);
        }
    }
    rgba
}

#[cfg(target_os = "windows")]
#[derive(Default)]
pub(crate) struct WindowsTrayState(pub std::sync::Mutex<(String, usize, usize)>);

#[cfg(target_os = "windows")]
pub(crate) fn system_uses_dark_taskbar() -> bool {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    let key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "SystemUsesLightTheme\0".encode_utf16().collect();
    let mut light: u32 = 0;
    let mut size = std::mem::size_of_val(&light) as u32;
    // Both strings are NUL-terminated; the output points to a DWORD-sized buffer.
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut light as *mut u32).cast(),
            &mut size,
        )
    };
    // Windows' default taskbar is dark; keep a visible white icon if unavailable.
    result != 0 || light == 0
}

#[cfg(target_os = "windows")]
pub(crate) fn watch_system_theme(app: tauri::AppHandle) {
    // App and system colors can change independently. Window ThemeChanged only
    // follows the app theme; check the taskbar setting even while hidden/idle.
    std::thread::spawn(move || {
        let mut previous = None;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(2));
            let current = system_uses_dark_taskbar();
            if Some(current) == previous {
                continue;
            }
            let handle = app.clone();
            if app
                .run_on_main_thread(move || {
                    use tauri::Manager;
                    let state = handle.state::<WindowsTrayState>();
                    let Ok(summary) = state.0.lock().map(|summary| summary.clone()) else {
                        return;
                    };
                    if let Some(tray) = handle.tray_by_id("racktop-tray") {
                        if let Err(error) =
                            tray.set_icon(Some(super::tray_image(&summary.0, summary.1, summary.2)))
                        {
                            eprintln!("Windows tray theme refresh failed: {error}");
                        }
                    }
                })
                .is_err()
            {
                break;
            }
            previous = Some(current);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::colorize;

    #[test]
    fn taskbar_colors_preserve_geometry_transparency_and_alert_opacity() {
        for mode in ["compact", "expanded"] {
            for counts in [(0, 0), (12, 3)] {
                let (original, width, height) = crate::render_tray_image(mode, counts.0, counts.1);
                for dark in [false, true] {
                    let colored = colorize(original.clone(), width as usize, dark);
                    assert_eq!(colored.len(), (width * height * 4) as usize);
                    for (index, (before, after)) in original
                        .chunks_exact(4)
                        .zip(colored.chunks_exact(4))
                        .enumerate()
                    {
                        assert_eq!(before[3], after[3]);
                        let x = index % width as usize;
                        let y = index / width as usize;
                        if x >= 36 || (width == 36 && (26..32).contains(&x) && (4..10).contains(&y))
                        {
                            assert_eq!(&after[..3], &[if dark { 255 } else { 0 }; 3]);
                        } else {
                            assert_eq!(before, after, "logo must retain its color");
                        }
                    }
                    assert_eq!(
                        colorize(colored, width as usize, !dark),
                        colorize(original.clone(), width as usize, !dark)
                    );
                }
            }
        }
    }
}
