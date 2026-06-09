package com.aamir.iciscreener.utils

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken
import com.aamir.iciscreener.core.Alert
import java.text.SimpleDateFormat
import java.util.Locale

object AlertManager {

    private const val PREF_NAME = "ici_alerts_prefs"
    private const val KEY_ALERTS = "alerts"
    private val gson = Gson()

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

    fun getActive(context: Context): List<Alert> =
        getAll(context).filter { it.active && !isExpired(it) }

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

    fun deactivate(context: Context, id: Long) {
        val alerts = getAll(context)
        alerts.find { it.id == id }?.active = false
        writeAll(context, alerts)
    }

    fun delete(context: Context, id: Long) {
        writeAll(context, getAll(context).filter { it.id != id }.toMutableList())
    }

    private fun isExpired(alert: Alert): Boolean {
        if (alert.expiry == "open") return false
        val now = System.currentTimeMillis()
        val created = try {
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
                .parse(alert.createdAt)?.time ?: return false
        } catch (e: Exception) { return false }

        return when (alert.expiry) {
            "1d" -> now > created + 86_400_000L
            "1w" -> now > created + 604_800_000L
            "1m" -> now > created + 2_592_000_000L
            "custom" -> {
                try {
                    val exp = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                        .parse(alert.expiryDate)?.time ?: return false
                    now > exp
                } catch (e: Exception) { false }
            }
            else -> false
        }
    }

    private fun writeAll(context: Context, alerts: MutableList<Alert>) {
        context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_ALERTS, gson.toJson(alerts))
            .apply()
    }
}
