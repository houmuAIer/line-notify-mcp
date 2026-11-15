import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Optional: android/keystore.properties (not committed) with storeFile,
// storePassword, keyAlias and keyPassword. With it every build is signed with
// the same key, so a new build installs over the old one and keeps its pairing.
// Without it the machine's debug key is used.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "io.github.houmuaier.linenotify"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.houmuaier.linenotify"
        minSdk = 29
        targetSdk = 36
        versionCode = 5
        versionName = "0.3.2"
    }

    signingConfigs {
        if (keystoreProperties.containsKey("storeFile")) {
            create("fixed") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        val fixed = signingConfigs.findByName("fixed")
        debug {
            if (fixed != null) signingConfig = fixed
        }
        release {
            isMinifyEnabled = false
            signingConfig = fixed ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    testImplementation("junit:junit:4.13.2")
}
