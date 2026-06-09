package com.aamir.iciscreener.core

data class Alert(
    val id: Long,
    val pair: String,
    val condition: String,
    val timeframe: String,
    val targetPrice: Double? = null,    // ✅ price alerts ke liye
    val name: String,
    val message: String,
    val frequency: String,
    val notify: List<String>,
    val sound: Boolean,
    val soundType: String,
    val expiry: String,
    val expiryDate: String,
    var active: Boolean = true,
    val createdAt: String = ""
)

data class PairData(
    val name: String,
    val h1: String,
    val h4: String,
    val d1: String,
    val w1: String,
    val sentiment: Int,
    val currentPrice: Double? = null,   // ✅ for price conditions
    val ema20: Double? = null           // ✅ for EMA conditions
) {
    fun getSignal(timeframe: String): String = when (timeframe) {
        "1H" -> h1
        "4H" -> h4
        "1D" -> d1
        "1W" -> w1
        else -> h1
    }
}
