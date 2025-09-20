
/**
 * Creates a position object from order data using Bybit V5 API structure
 * @param {Object} order - Order data from Bybit API
 * @param {number} leverage - Leverage to use (default: 20)
 * @returns {Object} - Position object structure
 */
export function createPositionFromOrder(order, leverage = 20) {
  let position = {
    "symbol": order.symbol,
    "size": parseFloat(order.qty) || 0,
    "side": order.side,
    "sizeUSD": 0,
    "pnl": 0,
    "liq": 0,
    "price": order.avgPrice || order.lastPrice,
    "stop_loss": order.stopLoss,
    "take_profit": order.takeProfit,
    "fee": 0,
    "_max_loss" : 0,
    "_liquidity_trigger": order.liquidity_trigger || "unknown",
    "_dca_count" : 0,
    "_start_price" : order.avgPrice || order.lastPrice,
    "_start_time" : order.createdTime || Date.now(),
    "_end_time": undefined,
    "leverage": leverage
  };

  // Calculate USD value using position's leverage if available, otherwise use default
  const positionLeverage = order.leverage || leverage;
  const usdValue = position.price * position.size / positionLeverage;
  position.sizeUSD = usdValue.toFixed(3);

  return position;
}

// DECOMMISSIONED FUNCTIONS:
// incrementPosition - Not used (bot manages positions directly via Bybit API)
// closePosition - Not used (bot closes positions via market orders)
// updatePosition - Not used (bot updates positions via direct API calls)
// newPosition - Legacy function, superseded by createPositionFromOrder
