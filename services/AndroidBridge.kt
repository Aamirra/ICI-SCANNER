// ─────────────────────────────────────────────────────────
// FILE: services/AndroidBridge.kt
// JavaScript ↔ Kotlin communication
// WebView ke andar JS ye functions call karta hai
// ─────────────────────────────────────────────────────────
package com.yourapp.services

import android.content.Context
import android.webkit.JavascriptInterface
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.yourapp.core.Alert
import com.yourapp.core.PairData
import com.yourapp.utils.AlertManager

class AndroidBridge(private val context: Context) {

    private val gson = Gson()

    // ── JS se alert save karo (HTML mein alert create/update hone pe) ──
    // HTML mein: Android.saveAlert(JSON.stringify(alert))
    @JavascriptInterface
    fun saveAlert(alertJson: String) {
        try {
            val alert = gson.fromJson(alertJson, Alert::class.java)
            AlertManager.save(context, alert)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // ── JS se alert delete karo ──
    // HTML mein: Android.deleteAlert(alertId)
    @JavascriptInterface
    fun deleteAlert(alertId: Long) {
        AlertManager.delete(context, alertId)
    }

    // ── JS se alert toggle karo ──
    // HTML mein: Android.toggleAlert(alertId, isActive)
    @JavascriptInterface
    fun toggleAlert(alertId: Long, isActive: Boolean) {
        val alerts = AlertManager.getAll(context)
        alerts.find { it.id == alertId }?.active = isActive
        // saveAll manually
        context.getSharedPreferences("ici_alerts_prefs", Context.MODE_PRIVATE)
            .edit()
            .putString("alerts", gson.toJson(alerts))
            .apply()
    }

    // ── JS scan ke baad latest market data save karo ──
    // HTML mein: Android.saveLatestData(JSON.stringify(pairsArray))
    // Ye background worker use karta hai
    @JavascriptInterface
    fun saveLatestData(pairsJson: String) {
        try {
            context.getSharedPreferences("ici_market_data", Context.MODE_PRIVATE)
                .edit()
                .putString("latest_pairs", pairsJson)
                .apply()

            // Data save hone ke baad foran alerts check karo
            AlertScheduler.checkNow(context)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    // ── Saved alerts JS ko wapas do (page load pe) ──
    // HTML mein: const alerts = JSON.parse(Android.getAlerts())
    @JavascriptInterface
    fun getAlerts(): String {
        return try {
            gson.toJson(AlertManager.getAll(context))
        } catch (e: Exception) {
            "[]"
        }
    }

    // ── Native notification bhejo (JS directly call kar sakta hai) ──
    // HTML mein: Android.showNotification("Title", "Message", "EURUSD")
    @JavascriptInterface
    fun showNotification(title: String, message: String, pair: String) {
        // AlertWorker ka sendNotification directly use karna better hai
        // Ye fallback hai
        android.util.Log.d("AndroidBridge", "Notification: $title - $message")
    }
}
