const COMMANDS: &[&str] = &["scan", "read_page", "save_pdf", "upload"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
