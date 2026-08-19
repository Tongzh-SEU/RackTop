#![cfg_attr(all(target_os = "windows", not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    if let Ok(password) = std::env::var("RACKTOP_ASKPASS_PASSWORD") {
        print!("{password}");
        return;
    }
    racktop_lib::run();
}
