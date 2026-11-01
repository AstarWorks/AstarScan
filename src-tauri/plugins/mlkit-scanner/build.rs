const COMMANDS: &[&str] = &["scan", "read_page", "save_pdf"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
