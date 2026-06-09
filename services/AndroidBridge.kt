package com.aamir.iciscreener.services

import android.content.Context
import android.webkit.JavascriptInterface
import com.google.gson.Gson
import com.aamir.iciscreener.core.Alert
import com.aamir.iciscreener.utils.AlertManager

class AndroidBridge(private val context: Context) {

    private val gson = Gson()

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

    @JavascriptInterface
    fun showNotification(title: String, message: String, pair: String) {
        // Optional fallback
    }
}
