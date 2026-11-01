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
    implementation(project(":tauri-android"))
}
