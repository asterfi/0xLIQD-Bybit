import { env } from 'process';

/**
 * Creates a market order for opening positions
 * @param {Object} restClient - Bybit REST client
 * @param {string} pair - Trading pair symbol
 * @param {string} side - Order side ("Buy" or "Sell")
 * @param {string} size - Order quantity
 * @param {number} take_profit - Take profit price (optional)
 * @param {number} stop_loss - Stop loss price (optional)
 * @returns {Object} - Order result from Bybit API
 */
export async function createMarketOrder(restClient, pair, side, size, take_profit = 0, stop_loss = 0) {

  var cfg = {
    category: 'linear',
    side: side,
    orderType: "Market",
    symbol: pair,
    qty: size,
    reduceOnly: false
  };

  // Note: TP/SL are set via setTradingStop() in the main bot logic
  // as Bybit V5 handles TP/SL differently from legacy APIs

  // send order payload
  const order = await restClient.submitOrder(cfg);
  return order;
}

// DECOMMISSIONED FUNCTIONS:
// createLimitOrder - Not used by the bot (only uses market orders for liquidation trading)
// cancelOrder - Not used (TP/SL management uses setTradingStop method instead)