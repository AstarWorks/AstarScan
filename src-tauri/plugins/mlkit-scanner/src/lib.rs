//! ML Kit Document Scanner bridge. The commands are implemented in Kotlin
//! (`android/`); the webview invokes them as `plugin:mlkit-scanner|<cmd>`
//! and Tauri forwards them to the Android plugin. Other platforms register
//! nothing, so the commands fail there and the web app keeps its own camera.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mlkit-scanner")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin("com.astarworks.mlkitscanner", "ScannerPlugin")?;
            Ok(())
        })
        .build()
}
