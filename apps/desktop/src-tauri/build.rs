fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_session_popout",
            "mcp_registration",
            "native_update",
        ]),
    ))
    .expect("native command manifest build failed")
}
