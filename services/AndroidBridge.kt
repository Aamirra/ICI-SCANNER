package com.aamir.iciscreener.services

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.webkit.JavascriptInterface
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.gson.Gson
import com.aamir.iciscreener.MainActivity
import com.aamir.iciscreener.core.Alert
import com.aamir.iciscreener.utils.AlertManager

class AndroidBridge(private val context: Context) {

    private val gson = Gson()
    private val CHANNEL_ID = AlertWorker.CHANNEL_ID   // use same channel as worker

    @JavascriptInterface
    fun saveAlert(alertJson: String) {
        try {
            val alert = gson.fromJson(alertJson, Alert::class.java)
            AlertManager.save(context, alert)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @JavascriptInterface
    fun deleteAlert(alertId: Long) {
        AlertManager.delete(context, alertId)
    }

    @JavascriptInterface
    fun toggleAlert(alertId: Long, isActive: Boolean) {
        val alerts = AlertManager.getAll(context)
        alerts.find { it.id == alertId }?.active = isActive
        context.getSharedPreferences("ici_alerts_prefs", Context.MODE_PRIVATE)
            .edit()
            .putString("alerts", gson.toJson(alerts))
            .apply()
    }

    @JavascriptInterface
    fun saveLatestData(pairsJson: String) {
        context.getSharedPreferences("ici_market_data", Context.MODE_PRIVATE)
            .edit()
            .putString("latest_pairs", pairsJson)
            .apply()
        AlertScheduler.checkNow(context)
    }

    @JavascriptInterface
    fun getAlerts(): String {
        return gson.toJson(AlertManager.getAll(context))
    }

    // ✅ FIX: Now it really sends a native notification
    @JavascriptInterface
    fun showNotification(title: String, message: String, pair: String) {
        try {
            val intent = Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("from_alert", true)
                putExtra("alert_pair", pair)
            }
            val pi = PendingIntent.getActivity(
                context,
                System.currentTimeMillis().toInt(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val notif = NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info) // apna icon laga sakte ho
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setDefaults(NotificationCompat.DEFAULT_SOUND or NotificationCompat.DEFAULT_VIBRATE)
                .build()

            NotificationManagerCompat.from(context).notify(
                System.currentTimeMillis().toInt(),
                notif
            )
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
