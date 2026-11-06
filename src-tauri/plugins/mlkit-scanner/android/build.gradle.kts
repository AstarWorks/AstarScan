plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.astarworks.mlkitscanner"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("proguard-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    // The capture screen's camera (CaptureActivity): preview, analysis
    // frames for the page frame, still pictures for the pages.
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    // Page corners: DocAligner (ONNX, assets/docaligner-lcnet100.onnx, put
    // there by scripts/android/fetch-docaligner.sh) on ONNX Runtime.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.19.2")
    // Page numbers: ML Kit Text Recognition v2, Japanese model (reads Latin
    // too), bundled so it works offline from the first scan.
    implementation("com.google.mlkit:text-recognition-japanese:16.0.1")
    implementation(project(":tauri-android"))
}
