use racktop_lib::storage::Database;
use std::path::PathBuf;

fn main() {
    let path = std::env::args_os().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        eprintln!("usage: migrate_storage <racktop.sqlite>");
        std::process::exit(2);
    });
    if let Err(error) = Database::open(&path) {
        eprintln!("RackTop history migration failed: {error}");
        std::process::exit(1);
    }
    println!("RackTop history migration completed: {}", path.display());
}
