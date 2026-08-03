fn main() {
    if let Ok(password) = std::env::var("RACKTOP_ASKPASS_PASSWORD") {
        print!("{password}");
        return;
    }
    racktop_lib::run();
}
