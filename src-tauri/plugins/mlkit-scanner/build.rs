const COMMANDS: &[&str] = &["scan", "read_page", "read_margins", "save_pdf", "upload"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
