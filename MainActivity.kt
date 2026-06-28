package com.aamir.iciscreener

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.graphics.Color
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.cardview.widget.CardView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import com.google.firebase.database.*
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.Executor
import java.security.MessageDigest

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var executor: Executor
    private lateinit var biometricPrompt: BiometricPrompt
    private lateinit var promptInfo: BiometricPrompt.PromptInfo
    private lateinit var deviceId: String
    private val database = FirebaseDatabase.getInstance().getReference("users")
    private val broadcastRef = FirebaseDatabase.getInstance().getReference("broadcast")

    private var isAdmin = false
    private var backPressedOnce = false
    private var isUnlocked = false

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted: Boolean -> }

    // ✅ SECURITY: Password ko SHA-256 hash mein convert karta hai
    private fun hashPassword(password: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hashBytes = digest.digest(password.toByteArray())
        return hashBytes.joinToString("") { "%02x".format(it) }
    }

    @SuppressLint("HardwareIds")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        getSharedPreferences("ICI_PREFS", Context.MODE_PRIVATE).edit().putString("deviceId", deviceId).apply()
        setupBackgroundWorker()
        setContentView(R.layout.access_request_layout)
        findViewById<View>(R.id.requestCard).visibility = View.GONE
        findViewById<View>(R.id.pendingLayout).visibility = View.GONE
        findViewById<TextView>(R.id.accessTitle).text = "ICI SCREENER"
        findViewById<TextView>(R.id.statusText).text = "Checking for updates..."

        checkUpdate {
            Handler(Looper.getMainLooper()).postDelayed({ checkAccess() }, 1000)
        }
    }

    private fun checkUpdate(onComplete: () -> Unit) {
        val currentVersion = try {
            packageManager.getPackageInfo(packageName, 0).versionCode
        } catch (e: Exception) { 1 }

        FirebaseDatabase.getInstance().getReference("app_version").addListenerForSingleValueEvent(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val latestVersion = snapshot.child("versionCode").getValue(Int::class.java) ?: 0
                val updateUrl = snapshot.child("updateUrl").getValue(String::class.java) ?: ""
                val isForce = snapshot.child("isForce").getValue(Boolean::class.java) ?: false

                if (latestVersion > currentVersion) {
                    val builder = androidx.appcompat.app.AlertDialog.Builder(this@MainActivity)
                        .setTitle("New Update Available")
                        .setMessage("Please update to the latest version to continue using ICI SCREENER.")
                        .setPositiveButton("Update Now") { _, _ ->
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(updateUrl)))
                            if (isForce) finish()
                        }

                    if (isForce) {
                        builder.setCancelable(false)
                    } else {
                        builder.setNegativeButton("Later") { dialog, _ ->
                            dialog.dismiss()
                            onComplete()
                        }
                    }
                    builder.show()
                } else {
                    onComplete()
                }
            }
            override fun onCancelled(error: DatabaseError) {
                onComplete()
            }
        })
    }

    private fun checkAccess() {
        database.child(deviceId).addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val status = snapshot.child("status").getValue(String::class.java)
                val role = snapshot.child("role").getValue(String::class.java)
                isAdmin = role == "admin"
                getSharedPreferences("ICI_PREFS", Context.MODE_PRIVATE).edit().putBoolean("isAdmin", isAdmin).apply()
                if (isAdmin) setupAdminNotificationListener()

                when (status) {
                    "approved" -> {
                        if (contentViewId != R.layout.activity_main) {
                            setContentView(R.layout.activity_main)
                            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                            webView = findViewById(R.id.webView)
                            progressBar = findViewById(R.id.progressBar)
                            setupWebView()
                            askNotificationPermission()
                            FirebaseMessaging.getInstance().subscribeToTopic("all_users")
                        }
                        if (!isUnlocked) checkBiometric()
                        
                        // ✅ FIX: "Contact Support" button for ALL approved users
                        setupFloatingSupportButton()
                    }
                    "pending" -> showRequestScreen(isPending = true)
                    "blocked" -> showBlockedScreen()
                    else -> showRequestScreen(isPending = false)
                }
            }
            override fun onCancelled(error: DatabaseError) {
                Toast.makeText(this@MainActivity, "Database Error: ${error.message}", Toast.LENGTH_LONG).show()
            }
        })
    }

    private fun setupWebView() {
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        window.setFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED, WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED)

        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.setSupportMultipleWindows(false)
        settings.javaScriptCanOpenWindowsAutomatically = true
        settings.setSupportZoom(true)
        settings.builtInZoomControls = true
        settings.displayZoomControls = false
        // ✅ FIX: Cache use karo lekin network se validate karo — data fresh rahega
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        settings.userAgentString = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"

        webView.clearCache(true)

        val apiMonitorText = findViewById<TextView>(R.id.apiMonitorText)
        val statusDot = findViewById<View>(R.id.statusDot)
        apiMonitorText.text = "Syncing API..."

        // ✅ FIX: Firebase marketData change hone par WebView ko JavaScript inject karo
        // Taake page reload ki zaroorat na ho — data seedha update ho
        FirebaseDatabase.getInstance().getReference("marketData")
            .addValueEventListener(object : ValueEventListener {
                override fun onDataChange(snapshot: DataSnapshot) {
                    try {
                        // JSON string banao saare market data ka
                        val sb = StringBuilder("{")
                        var first = true
                        for (child in snapshot.children) {
                            if (!first) sb.append(",")
                            first = false
                            sb.append("\"${child.key}\":{") 
                            var firstTf = true
                            for (tf in child.children) {
                                if (!firstTf) sb.append(",")
                                firstTf = false
                                val value = tf.getValue(String::class.java) ?: ""
                                sb.append("\"${tf.key}\":\"$value\"")
                            }
                            sb.append("}")
                        }
                        sb.append("}")
                        val jsonData = sb.toString()
                        // WebView mein MARKET_DATA update karo aur render() call karo
                        val js = "javascript:(function(){ MARKET_DATA = $jsonData; if(typeof render === 'function') render(); if(typeof updateCounts === 'function') updateCounts(); })()"
                        Handler(Looper.getMainLooper()).post {
                            webView.loadUrl(js)
                        }
                    } catch (e: Exception) {
                        // Fallback: page reload kar do
                        Handler(Looper.getMainLooper()).post {
                            webView.reload()
                        }
                    }
                }
                override fun onCancelled(error: DatabaseError) {}
            })

        FirebaseDatabase.getInstance().getReference("api_status").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                if (!snapshot.exists()) {
                    apiMonitorText.text = "Waiting for Server..."
                    return
                }
                val remaining = snapshot.child("remaining").getValue(Int::class.java) ?: 0
                val total = snapshot.child("total").getValue(Int::class.java) ?: 12800
                apiMonitorText.text = "DATA LIMIT: $remaining / $total"

                if (remaining < 800) {
                    apiMonitorText.setTextColor(android.graphics.Color.RED)
                    statusDot.setBackgroundResource(R.drawable.dot_red)
                } else {
                    apiMonitorText.setTextColor(android.graphics.Color.parseColor("#CCFFFFFF"))
                    statusDot.setBackgroundResource(R.drawable.dot_green)
                }
            }
            override fun onCancelled(error: DatabaseError) {
                apiMonitorText.text = "Sync Error"
            }
        })

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true)
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
            val nightModeFlags = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
            if (nightModeFlags == Configuration.UI_MODE_NIGHT_YES) {
                WebSettingsCompat.setForceDark(settings, WebSettingsCompat.FORCE_DARK_ON)
            }
        }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) { progressBar.visibility = View.GONE }
            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean { return false }
        }

        webView.webChromeClient = WebChromeClient()
        WebView.setWebContentsDebuggingEnabled(true)

        // ✅ FIXED URL: Naya dashboard (AI assistant, live prices, etc.)
        val url = if (isAdmin) "https://ici-scanner.onrender.com?mode=admin" else "https://ici-scanner.onrender.com"
        webView.loadUrl(url)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("if(typeof closeAllModals === 'function') closeAllModals();", null)
                Handler(Looper.getMainLooper()).postDelayed({
                    if (webView.canGoBack()) {
                        webView.goBack()
                    } else {
                        if (backPressedOnce) finish()
                        else {
                            backPressedOnce = true
                            Toast.makeText(this@MainActivity, "Press back again to exit", Toast.LENGTH_SHORT).show()
                            Handler(Looper.getMainLooper()).postDelayed({ backPressedOnce = false }, 2000)
                        }
                    }
                }, 100)
            }
        })
    }

    private fun setupBackgroundWorker() {
        val workRequest = PeriodicWorkRequestBuilder<BackgroundWorker>(15, TimeUnit.MINUTES).build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("ICI_BG_WORK", ExistingPeriodicWorkPolicy.KEEP, workRequest)
    }

    private fun setupAdminNotificationListener() {
        database.addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {
                if (snapshot.child("status").getValue(String::class.java) == "pending") {
                    showLocalNotification("New Request", "User ${snapshot.child("telegram").getValue(String::class.java)} waiting")
                }
            }
            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildRemoved(snapshot: DataSnapshot) {}
            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onCancelled(error: DatabaseError) {}
        })
    }

    private fun showLocalNotification(title: String, message: String) {
        val channelId = "ici_notif"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(channelId, "Alerts", NotificationManager.IMPORTANCE_HIGH))
        }
        val notif = NotificationCompat.Builder(this, channelId)
            .setSmallIcon(R.mipmap.ic_launcher).setContentTitle(title).setContentText(message)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setAutoCancel(true).build()
        nm.notify(System.currentTimeMillis().toInt(), notif)
    }

    private fun showRequestScreen(isPending: Boolean) {
        setContentView(R.layout.access_request_layout)
        val accessTitle = findViewById<TextView>(R.id.accessTitle)
        accessTitle.setOnLongClickListener { showAdminPasswordDialog(); true }

        findViewById<Button>(R.id.contactAdminBtn).setOnClickListener {
            val url = "https://wa.me/923324333291"
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        }

        if (isPending) {
            findViewById<View>(R.id.requestCard).visibility = View.GONE
            findViewById<View>(R.id.pendingLayout).visibility = View.VISIBLE
        } else {
            findViewById<Button>(R.id.requestButton).setOnClickListener {
                val telegram = findViewById<EditText>(R.id.telegramEditText).text.toString().trim()
                if (telegram.isNotEmpty()) {
                    database.child(deviceId).setValue(mapOf(
                        "telegram" to telegram,
                        "status" to "pending",
                        "deviceId" to deviceId,
                        "timestamp" to System.currentTimeMillis()
                    ))
                }
            }
        }
    }

    // ✅ SECURITY: Password hash comparison
    private fun showAdminPasswordDialog() {
        val input = EditText(this)
        input.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        input.hint = "Admin Password"

        AlertDialog.Builder(this)
            .setTitle("Admin Login")
            .setView(input)
            .setPositiveButton("Login") { _, _ ->
                val enteredPassword = input.text.toString().trim()
                if (enteredPassword.isEmpty()) return@setPositiveButton
                val enteredHash = hashPassword(enteredPassword)

                FirebaseDatabase.getInstance()
                    .getReference("admin_config/password_hash")
                    .addListenerForSingleValueEvent(object : ValueEventListener {
                        override fun onDataChange(snapshot: DataSnapshot) {
                            val savedHash = snapshot.getValue(String::class.java) ?: ""
                            if (enteredHash == savedHash) {
                                database.child(deviceId).updateChildren(
                                    mapOf("status" to "approved", "role" to "admin")
                                )
                                Toast.makeText(this@MainActivity, "✅ Admin Login Successful", Toast.LENGTH_SHORT).show()
                            } else {
                                Toast.makeText(this@MainActivity, "❌ Wrong Password", Toast.LENGTH_SHORT).show()
                            }
                        }
                        override fun onCancelled(error: DatabaseError) {
                            Toast.makeText(this@MainActivity, "Error checking password", Toast.LENGTH_SHORT).show()
                        }
                    })
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showBlockedScreen() {
        setContentView(R.layout.access_request_layout)
        findViewById<TextView>(R.id.statusText).text = "Your access is blocked."
    }

    // ✅ SIRF YEH ADD KIYA HAI: Floating Support Button
    private fun setupFloatingSupportButton() {
        val rootLayout = findViewById<ViewGroup>(android.R.id.content)
        val existingBtn = rootLayout.findViewWithTag<View>("support_btn")
        if (existingBtn != null) rootLayout.removeView(existingBtn)

        val supportBtn = CardView(this).apply {
            tag = "support_btn"
            radius = 40f
            cardElevation = 8f
            alpha = 0.8f
            setCardBackgroundColor(Color.parseColor("#1a2e42"))
            
            layoutParams = FrameLayout.LayoutParams(90, 90).apply {
                gravity = Gravity.BOTTOM or Gravity.END
                setMargins(0, 0, 30, 150)
            }
            
            val icon = ImageView(this@MainActivity).apply {
                setImageResource(if (isAdmin) android.R.drawable.ic_lock_lock else android.R.drawable.ic_menu_help) 
                setColorFilter(Color.parseColor("#00aaff"))
                setPadding(18, 18, 18, 18)
            }
            addView(icon)

            setOnClickListener { 
                if (isAdmin) showAdminOrSupportDialog() else contactSupport()
            }
        }
        rootLayout.addView(supportBtn)
    }

    private fun showAdminOrSupportDialog() {
        val options = arrayOf("Admin Panel", "Contact Support")
        AlertDialog.Builder(this)
            .setTitle("Menu")
            .setItems(options) { _, which ->
                if (which == 0) showAdminPanel() else contactSupport()
            }.show()
    }

    private fun contactSupport() {
        val url = "https://wa.me/923324333291"
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
    }

    private fun showAdminPanel() {
        setContentView(R.layout.admin_panel_layout)
        findViewById<Button>(R.id.backToWebBtn).setOnClickListener { checkAccess() }

        val broadcastMsgEdit = findViewById<EditText>(R.id.broadcastMsgEdit)
        findViewById<Button>(R.id.sendBroadcastBtn).setOnClickListener {
            val msg = broadcastMsgEdit.text.toString().trim()
            if (msg.isNotEmpty()) {
                broadcastRef.setValue(mapOf(
                    "message" to msg,
                    "timestamp" to System.currentTimeMillis()
                )).addOnSuccessListener {
                    Toast.makeText(this, "Broadcast Sent Successfully", Toast.LENGTH_SHORT).show()
                    broadcastMsgEdit.setText("")
                }.addOnFailureListener {
                    Toast.makeText(this, "Failed to send broadcast", Toast.LENGTH_SHORT).show()
                }
            }
        }

        database.addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val userList = snapshot.children.filter { it.child("role").getValue(String::class.java) != "admin" }
                findViewById<ListView>(R.id.userListView).adapter = object : ArrayAdapter<DataSnapshot>(this@MainActivity, R.layout.user_item_layout, userList) {
                    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
                        val view = convertView ?: layoutInflater.inflate(R.layout.user_item_layout, parent, false)
                        val user = getItem(position)!!
                        view.findViewById<TextView>(R.id.userNameTxt).text = user.child("telegram").getValue(String::class.java)
                        view.findViewById<TextView>(R.id.statusTxt).text = user.child("status").getValue(String::class.java)
                        view.findViewById<Button>(R.id.approveBtn).setOnClickListener { database.child(user.key!!).child("status").setValue("approved") }
                        view.findViewById<Button>(R.id.blockBtn).setOnClickListener { database.child(user.key!!).child("status").setValue("blocked") }
                        return view
                    }
                }
            }
            override fun onCancelled(error: DatabaseError) {}
        })
    }

    private fun askNotificationPermission() {
        FirebaseMessaging.getInstance().subscribeToTopic("all_users")
    }

    private var contentViewId: Int = 0
    override fun setContentView(layoutResID: Int) { super.setContentView(layoutResID); contentViewId = layoutResID }

    private fun checkBiometric() {
        val bm = BiometricManager.from(this)
        if (bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS) {
            biometricPrompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    isUnlocked = true
                }
            })
            promptInfo = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Login")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                .build()
            biometricPrompt.authenticate(promptInfo)
        }
    }
}
