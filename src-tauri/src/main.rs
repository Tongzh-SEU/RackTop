#![cfg_attr(all(target_os = "windows", not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "--racktop-proxy") {
        let result = if args.len() == 5 { racktop_lib::ssh_routes::run_proxy(&args[2], &args[3], &args[4]) } else { Err("跳板机参数无效".into()) };
        match result { Ok(code) => std::process::exit(code), Err(error) => { eprintln!("{error}"); std::process::exit(1); } }
    }
    if let Ok(password) = std::env::var("RACKTOP_ASKPASS_PASSWORD") {
        print!("{password}");
        return;
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // Set before Tauri starts threads; avoids blank WebKitGTK windows on
        // drivers that cannot import DMA-BUF buffers. Users can override it.
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    racktop_lib::run();
}
