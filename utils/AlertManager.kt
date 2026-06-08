// ─────────────────────────────────────────────────────────
// FILE: utils/AlertManager.kt
// Alerts ko SharedPreferences mein save/load karta hai
// (WorkManager localStorage access nahi kar sakta,
//  isliye SharedPreferences use karte hain)
// ─────────────────────────────────────────────────────────
package com.yourapp.utils

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.yourapp.core.Alert

object AlertManager {

    private const val PREF_NAME = "ici_alerts_prefs"
    private const val KEY_ALERTS = "alerts"
    private val gson = Gson()

    // ── Sab alerts load karo ──
    fun getAll(context: Context): MutableList<Alert> {
        val prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
        val json = prefs.getString(KEY_ALERTS, null) ?: return mutableListOf()
        return try {
            val type = object : TypeToken<MutableList<Alert>>() {}.type
            gson.fromJson(json, type) ?: mutableListOf()
        } catch (e: Exception) {
            mutableListOf()
        }
    }

    // ── Active alerts sirf ──
    fun getActive(context: Context): List<Alert> =
        getAll(context).filter { it.active && !isExpired(it) }

    // ── Ek alert save karo (JS se aata hai) ──
    fun save(context: Context, alert: Alert) {
        val alerts = getAll(context)
        val existingIndex = alerts.indexOfFirst { it.id == alert.id }
        if (existingIndex >= 0) {
            alerts[existingIndex] = alert
        } else {
            alerts.add(alert)
        }
        writeAll(context, alerts)
    }

    // ── Alert deactivate karo (Only Once trigger ke baad) ──
    fun deactivate(context: Context, id: Long) {
        val alerts = getAll(context)
        alerts.find { it.id == id }?.active = false
        writeAll(context, alerts)
    }

    // ── Alert delete karo ──
    fun delete(context: Context, id: Long) {
        writeAll(context, getAll(context).filter { it.id != id }.toMutableList())
    }

    // ── Expiry check karo ──
    private fun isExpired(alert: Alert): Boolean {
        if (alert.expiry == "open") return false
        val now = System.currentTimeMillis()
        val created = try {
            java.text.SimpleDateFormat("MM/dd/yyyy, hh:mm:ss a", java.util.Locale.US)
                .parse(alert.createdAt)?.time ?: return false
        } catch (e: Exception) { return false }

        return when (alert.expiry) {
            "1d" -> now > created + 86_400_000L
            "1w" -> now > created + 604_800_000L
            "1m" -> now > created + 2_592_000_000L
            "custom" -> {
                try {
                    val exp = java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                        .parse(alert.expiryDate)?.time ?: return false
                    now > exp
                } catch (e: Exception) { false }
            }
            else -> false
        }
    }

    // ── Internal: disk pe likhna ──
    private fun writeAll(context: Context, alerts: MutableList<Alert>) {
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ALERTS, gson.toJson(alerts))
            .apply()
    }
}
