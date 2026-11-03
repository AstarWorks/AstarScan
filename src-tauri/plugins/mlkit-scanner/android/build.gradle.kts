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
    // Scanner UI, edge detection and auto-capture run inside Google Play
    // services; the app only holds the thin client (no model in the APK).
    implementation("com.google.android.gms:play-services-mlkit-document-scanner:16.0.0")
    // ModuleInstallClient: check / request the scanner's Play services
    // module before opening it (ScannerPlugin.startScan).
    implementation("com.google.android.gms:play-services-base:18.5.0")
    // Page numbers: ML Kit Text Recognition v2, Japanese model (reads Latin
    // too), bundled so it works offline from the first scan.
    implementation("com.google.mlkit:text-recognition-japanese:16.0.1")
    implementation(project(":tauri-android"))
}
