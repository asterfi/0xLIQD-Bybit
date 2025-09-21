import { env } from 'process';

/**
 * Creates a market order for opening positions
 * @param {Object} restClient - Bybit REST client
 * @param {string} pair - Trading pair symbol
 * @param {string} side - Order side ("Buy" or "Sell")
 * @param {string} size - Order quantity
 * @param {number} positionIdx - Position index (0=one-way, 1=hedge Buy, 2=hedge Sell)
 * @returns {Object} - Order result from Bybit API
 */
export async function createMarketOrder(restClient, pair, side, size, positionIdx = 0) {

  var cfg = {
    category: 'linear',
    side: side,
    orderType: "Market",
    symbol: pair,
    qty: size,
    reduceOnly: false,
    positionIdx: positionIdx
  };

  // Note: TP/SL are set via setTradingStop() in the main bot logic
  // as Bybit V5 handles TP/SL differently from legacy APIs

  // send order payload
  const order = await restClient.submitOrder(cfg);
  return order;
}