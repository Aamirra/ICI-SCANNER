// ─────────────────────────────────────────────────────────
// FILE: core/AlertModel.kt
// Alert ka data structure
// ─────────────────────────────────────────────────────────
package com.yourapp.core

data class Alert(
    val id: Long,
    val pair: String,           // "EURUSD"
    val condition: String,      // "BULL_SIGNAL", "BEAR_SIGNAL", etc.
    val timeframe: String,      // "Any", "1H", "4H", "1D", "1W"
    val name: String,           // User ka naam
    val message: String,        // "{{ticker}} signal changed!"
    val frequency: String,      // "Only Once", "Once Per Bar", "Every Time"
    val notify: List<String>,   // ["push", "popup"]
    val sound: Boolean,
    val soundType: String,
    val expiry: String,         // "open", "1d", "1w", "custom"
    val expiryDate: String,
    var active: Boolean = true,
    val createdAt: String = ""
)

// Pair ki current market data
data class PairData(
    val name: String,   // "EURUSD"
    val h1: String,     // "BULL" ya "BEAR"
    val h4: String,
    val d1: String,
    val w1: String,
    val sentiment: Int  // 0-100
) {
    fun getSignal(timeframe: String): String = when (timeframe) {
        "1H" -> h1
        "4H" -> h4
        "1D" -> d1
        "1W" -> w1
        else -> h1
    }
}
