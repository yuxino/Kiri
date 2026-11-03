fn main() {
    // Tauri embeds the ICNS in dev binaries and bundles the same desktop
    // assets for production. Keep icon-only edits from reusing a stale build.
    for icon in [
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        "icons/icon.icns",
        "icons/icon.ico",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").expect("missing target platform");
    if target_os == "macos" {
        println!("cargo:rerun-if-changed=src/macos_media.m");
        println!("cargo:rerun-if-changed=src/macos_audio.m");
        println!("cargo:rerun-if-changed=src/video_export.m");
        println!("cargo:rerun-if-changed=src/macos_startup.m");
        cc::Build::new()
            .file("src/macos_media.m")
            .file("src/macos_audio.m")
            .file("src/video_export.m")
            .file("src/macos_startup.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .compile("kiri_macos_media");
        for framework in [
            "AVFoundation",
            "CoreGraphics",
            "CoreImage",
            "CoreMedia",
            "CoreVideo",
            "Foundation",
            "ImageIO",
            "UniformTypeIdentifiers",
            "ServiceManagement",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }

    if target_os == "windows" {
        println!("cargo:rerun-if-changed=ocr/windows-runtime.mjs");
        let prepared = std::process::Command::new("node")
            .arg("ocr/windows-runtime.mjs")
            .status()
            .expect("Node.js is required to prepare the Windows OCR runtime");
        assert!(
            prepared.success(),
            "could not verify the Windows OCR runtime"
        );
    }

    tauri_build::build()
}
