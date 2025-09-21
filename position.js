
/**
 * Creates a position object from order data using Bybit V5 API structure
 * @param {Object} order - Order data from Bybit API
 * @param {number} leverage - Leverage to use (default: 20)
 * @param {boolean} hedgeMode - Whether hedge mode is enabled
 * @returns {Object} - Position object structure
 */
export function createPositionFromOrder(order, leverage = 20, hedgeMode = false) {
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
    "leverage": leverage,
    "hedgeMode": hedgeMode
  };

  // Calculate USD value using position's leverage if available, otherwise use default
  const positionLeverage = order.leverage || leverage;

  // In hedge mode, calculate net position size and USD value more accurately
  if (hedgeMode) {
    // For hedge mode, we track each side independently
    // USD value should consider the full position size without leverage adjustment
    const usdValue = position.price * position.size;
    position.sizeUSD = usdValue.toFixed(3);

    // Add hedge mode specific properties
    position.netSize = position.size;
    position.isHedged = true;
  } else {
    // For one-way mode, traditional calculation
    const usdValue = position.price * position.size / positionLeverage;
    position.sizeUSD = usdValue.toFixed(3);
    position.netSize = position.size;
    position.isHedged = false;
  }

  return position;
}

/**
 * Calculates P&L for hedged positions by considering both long and short sides
 * @param {Object} longPosition - Long position data (can be null)
 * @param {Object} shortPosition - Short position data (can be null)
 * @param {number} currentPrice - Current market price
 * @returns {Object} - P&L calculations for both positions
 */
export function calculateHedgePNL(longPosition, shortPosition, currentPrice) {
  const result = {
    longPNL: 0,
    shortPNL: 0,
    netPNL: 0,
    longUnrealizedPNL: 0,
    shortUnrealizedPNL: 0,
    netUnrealizedPNL: 0
  };

  // Calculate long position P&L
  if (longPosition && longPosition.size > 0) {
    const longSize = parseFloat(longPosition.size);
    const longEntryPrice = parseFloat(longPosition.price) || 0;
    const longCurrentPrice = parseFloat(currentPrice) || 0;

    // Unrealized P&L for long position
    result.longUnrealizedPNL = (longCurrentPrice - longEntryPrice) * longSize;
    // Realized P&L (including fees, commissions, etc.)
    result.longPNL = result.longUnrealizedPNL;
  }

  // Calculate short position P&L
  if (shortPosition && shortPosition.size > 0) {
    const shortSize = parseFloat(shortPosition.size);
    const shortEntryPrice = parseFloat(shortPosition.price) || 0;
    const shortCurrentPrice = parseFloat(currentPrice) || 0;

    // Unrealized P&L for short position
    result.shortUnrealizedPNL = (shortEntryPrice - shortCurrentPrice) * shortSize;
    // Realized P&L (including fees, commissions, etc.)
    result.shortPNL = result.shortUnrealizedPNL;
  }

  // Calculate net P&L
  result.netUnrealizedPNL = result.longUnrealizedPNL + result.shortUnrealizedPNL;
  result.netPNL = result.longPNL + result.shortPNL;

  return result;
}

/**
 * Merges position data for hedge mode to provide a consolidated view
 * @param {Object[]} positions - Array of position objects
 * @returns {Object} - Merged position data
 */
export function mergeHedgePositions(positions) {
  const merged = {
    symbol: positions[0]?.symbol || '',
    totalLongSize: 0,
    totalShortSize: 0,
    netSize: 0,
    avgLongPrice: 0,
    avgShortPrice: 0,
    totalLongValue: 0,
    totalShortValue: 0,
    isHedged: false,
    hedgeMode: true
  };

  let longTotalSize = 0;
  let shortTotalSize = 0;
  let longTotalValue = 0;
  let shortTotalValue = 0;

  positions.forEach(position => {
    if (position.side === 'Buy') {
      const size = parseFloat(position.size) || 0;
      const price = parseFloat(position.price) || 0;
      longTotalSize += size;
      longTotalValue += size * price;
    } else if (position.side === 'Sell') {
      const size = parseFloat(position.size) || 0;
      const price = parseFloat(position.price) || 0;
      shortTotalSize += size;
      shortTotalValue += size * price;
    }
  });

  merged.totalLongSize = longTotalSize;
  merged.totalShortSize = shortTotalSize;
  merged.netSize = longTotalSize - shortTotalSize;
  merged.avgLongPrice = longTotalSize > 0 ? longTotalValue / longTotalSize : 0;
  merged.avgShortPrice = shortTotalSize > 0 ? shortTotalValue / shortTotalSize : 0;
  merged.totalLongValue = longTotalValue;
  merged.totalShortValue = shortTotalValue;
  merged.isHedged = longTotalSize > 0 && shortTotalSize > 0;

  return merged;
}
