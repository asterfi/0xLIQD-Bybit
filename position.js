
/**
 * Market Order Management Module
 * Handles creation of position objects with proper hedge mode support for Bybit V5
 */

import { logIT, LOG_LEVEL } from './log.js';

/**
 * Creates a position object from order data using Bybit V5 API structure
 * Handles both hedge mode and one-way mode with proper USD value calculations
 *
 * @param {Object} order - Order data from Bybit API
 * @param {number} leverage - Leverage to use (default: 20)
 * @param {boolean} hedgeMode - Whether hedge mode is enabled
 * @returns {Object} - Position object structure with USD value and metadata
 */
export function createPositionFromOrder(order, leverage = 20, hedgeMode = false) {
  try {
    // Validate input parameters
    if (!order || !order.symbol) {
      throw new Error('Invalid order data: missing order object or symbol');
    }

    // Extract order details with fallback values
    const position = {
      symbol: order.symbol,
      size: parseFloat(order.qty) || 0,
      side: order.side || 'Unknown',
      sizeUSD: 0,
      pnl: 0,
      liq: 0,
      price: order.avgPrice || order.lastPrice || 0,
      stop_loss: order.stopLoss,
      take_profit: order.takeProfit,
      fee: 0,
      _max_loss: 0,
      _liquidity_trigger: order.liquidity_trigger || 'unknown',
      _dca_count: 0,
      _start_price: order.avgPrice || order.lastPrice || 0,
      _start_time: order.createdTime || Date.now(),
      _end_time: undefined,
      leverage: leverage,
      hedgeMode: hedgeMode
    };

    // Use position's leverage if available, otherwise use default
    const positionLeverage = order.leverage || leverage;

    // Calculate USD value based on position mode
    if (hedgeMode) {
      // Hedge mode: track each side independently
      // USD value considers full position size without leverage adjustment
      const usdValue = position.price * position.size;
      position.sizeUSD = usdValue.toFixed(3);

      // Add hedge mode specific properties
      position.netSize = position.size;
      position.isHedged = true;

      logIT(`Created hedge mode position: ${position.side} ${position.size} ${position.symbol} (USD: ${position.sizeUSD})`, LOG_LEVEL.INFO);
    } else {
      // One-way mode: traditional calculation with leverage consideration
      const usdValue = position.price * position.size / positionLeverage;
      position.sizeUSD = usdValue.toFixed(3);
      position.netSize = position.size;
      position.isHedged = false;

      logIT(`Created one-way position: ${position.side} ${position.size} ${position.symbol} (Leverage: ${positionLeverage}, USD: ${position.sizeUSD})`, LOG_LEVEL.INFO);
    }

    return position;
  } catch (error) {
    logIT(`Error creating position from order: ${error.message}`, LOG_LEVEL.ERROR);
    throw error;
  }
}

/**
 * Calculates P&L for hedged positions by considering both long and short sides
 * Provides comprehensive P&L analysis including realized and unrealized gains
 *
 * @param {Object} longPosition - Long position data (can be null/undefined)
 * @param {Object} shortPosition - Short position data (can be null/undefined)
 * @param {number} currentPrice - Current market price
 * @returns {Object} - P&L calculations for both positions with net totals
 */
export function calculateHedgePNL(longPosition, shortPosition, currentPrice) {
  try {
    const result = {
      longPNL: 0,
      shortPNL: 0,
      netPNL: 0,
      longUnrealizedPNL: 0,
      shortUnrealizedPNL: 0,
      netUnrealizedPNL: 0
    };

    // Calculate long position P&L if position exists
    if (longPosition && longPosition.size > 0) {
      const longSize = parseFloat(longPosition.size);
      const longEntryPrice = parseFloat(longPosition.price) || 0;
      const longCurrentPrice = parseFloat(currentPrice) || 0;

      // Unrealized P&L calculation for long position
      result.longUnrealizedPNL = (longCurrentPrice - longEntryPrice) * longSize;
      // Currently unrealized P&L equals realized P&L (no closed positions)
      result.longPNL = result.longUnrealizedPNL;

      logIT(`Long position P&L: ${result.longPNL.toFixed(2)} (Entry: ${longEntryPrice}, Current: ${longCurrentPrice}, Size: ${longSize})`, LOG_LEVEL.DEBUG);
    }

    // Calculate short position P&L if position exists
    if (shortPosition && shortPosition.size > 0) {
      const shortSize = parseFloat(shortPosition.size);
      const shortEntryPrice = parseFloat(shortPosition.price) || 0;
      const shortCurrentPrice = parseFloat(currentPrice) || 0;

      // Unrealized P&L calculation for short position
      result.shortUnrealizedPNL = (shortEntryPrice - shortCurrentPrice) * shortSize;
      // Currently unrealized P&L equals realized P&L (no closed positions)
      result.shortPNL = result.shortUnrealizedPNL;

      logIT(`Short position P&L: ${result.shortPNL.toFixed(2)} (Entry: ${shortEntryPrice}, Current: ${shortCurrentPrice}, Size: ${shortSize})`, LOG_LEVEL.DEBUG);
    }

    // Calculate net P&L across all positions
    result.netUnrealizedPNL = result.longUnrealizedPNL + result.shortUnrealizedPNL;
    result.netPNL = result.longPNL + result.shortPNL;

    logIT(`Net P&L calculation: ${result.netPNL.toFixed(2)} (Unrealized: ${result.netUnrealizedPNL.toFixed(2)})`, LOG_LEVEL.INFO);

    return result;
  } catch (error) {
    logIT(`Error calculating hedge P&L: ${error.message}`, LOG_LEVEL.ERROR);
    throw error;
  }
}

/**
 * Merges position data for hedge mode to provide a consolidated view
 * Aggregates multiple positions for the same symbol into comprehensive statistics
 *
 * @param {Object[]} positions - Array of position objects for the same trading pair
 * @returns {Object} - Merged position data with aggregated statistics
 */
export function mergeHedgePositions(positions) {
  try {
    // Validate input
    if (!Array.isArray(positions) || positions.length === 0) {
      throw new Error('Invalid positions array: must be a non-empty array');
    }

    // Initialize merged position object
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

    // Initialize aggregation variables
    let longTotalSize = 0;
    let shortTotalSize = 0;
    let longTotalValue = 0;
    let shortTotalValue = 0;

    // Process each position in the array
    positions.forEach((position, index) => {
      if (!position || !position.side) {
        logIT(`Skipping invalid position at index ${index}: missing side property`, LOG_LEVEL.WARNING);
        return;
      }

      const size = parseFloat(position.size) || 0;
      const price = parseFloat(position.price) || 0;

      if (position.side === 'Buy') {
        // Aggregate long position data
        longTotalSize += size;
        longTotalValue += size * price;
        logIT(`Added long position: ${size} @ ${price} (Symbol: ${position.symbol})`, LOG_LEVEL.DEBUG);
      } else if (position.side === 'Sell') {
        // Aggregate short position data
        shortTotalSize += size;
        shortTotalValue += size * price;
        logIT(`Added short position: ${size} @ ${price} (Symbol: ${position.symbol})`, LOG_LEVEL.DEBUG);
      } else {
        logIT(`Unknown position side: ${position.side} for symbol ${position.symbol}`, LOG_LEVEL.WARNING);
      }
    });

    // Calculate merged position statistics
    merged.totalLongSize = longTotalSize;
    merged.totalShortSize = shortTotalSize;
    merged.netSize = longTotalSize - shortTotalSize;
    merged.avgLongPrice = longTotalSize > 0 ? longTotalValue / longTotalSize : 0;
    merged.avgShortPrice = shortTotalSize > 0 ? shortTotalValue / shortTotalSize : 0;
    merged.totalLongValue = longTotalValue;
    merged.totalShortValue = shortTotalValue;
    merged.isHedged = longTotalSize > 0 && shortTotalSize > 0;

    // Log consolidated position information
    logIT(`Merged position stats for ${merged.symbol}: Long: ${merged.totalLongSize}, Short: ${merged.totalShortSize}, Net: ${merged.netSize.toFixed(2)}, Hedged: ${merged.isHedged}`, LOG_LEVEL.INFO);

    return merged;
  } catch (error) {
    logIT(`Error merging hedge positions: ${error.message}`, LOG_LEVEL.ERROR);
    throw error;
  }
}
