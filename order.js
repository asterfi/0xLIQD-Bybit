/**
 * Market Order Management Module
 * Handles creation of market orders with proper position index handling for Bybit V5
 */

import { env } from 'process';

/**
 * Create a market order for opening positions
 * Supports both one-way and hedge mode with proper position index mapping
 *
 * @param {Object} restClient - Bybit REST client instance
 * @param {string} pair - Trading pair symbol (e.g., 'BTCUSDT')
 * @param {string} side - Order side ('Buy' or 'Sell')
 * @param {string|number} size - Order quantity in contracts
 * @param {number} positionIdx - Position index for hedge mode:
 *   0 = one-way mode position
 *   1 = Buy side of hedge-mode position
 *   2 = Sell side of hedge-mode position
 * @returns {Promise<Object>} Order result from Bybit API
 */
export async function createMarketOrder(restClient, pair, side, size, positionIdx = 0) {
  try {
    // Validate input parameters
    if (!restClient || !pair || !side || !size) {
      throw new Error('Missing required parameters for market order');
    }

    // Prepare order configuration
    const orderConfig = {
      category: 'linear',
      side: side,
      orderType: 'Market',
      symbol: pair,
      qty: String(size), // Ensure quantity is string type
      reduceOnly: false, // Always false for opening new positions
      positionIdx: positionIdx
    };

    // Execute market order
    logIT(`Creating market order: ${side} ${size} ${pair} (positionIdx: ${positionIdx})`, LOG_LEVEL.INFO);

    const order = await restClient.submitOrder(orderConfig);

    // Log order result
    if (order.retCode === 0) {
      logIT(`Market order created successfully: ${order.result.orderId}`, LOG_LEVEL.INFO);
    } else {
      logIT(`Market order failed: ${order.retMsg} (Code: ${order.retCode})`, LOG_LEVEL.ERROR);
    }

    return order;
  } catch (error) {
    logIT(`Error creating market order for ${pair}: ${error.message}`, LOG_LEVEL.ERROR);
    throw error; // Re-throw to allow calling function to handle
  }
}