import fs from "fs";
import moment from "moment";
import chalk from "chalk";
import { logIT, LOG_LEVEL } from "./log.js";

// Utility function to calculate risk-adjusted prices
export function calculateRiskPrices(longPrice, shortPrice, riskLevel = 2) {
    const riskMultiplier = {
        1: { long: 1.005, short: 0.995 },
        2: { long: 1.01, short: 0.99 },
        3: { long: 1.02, short: 0.98 },
        4: { long: 1.03, short: 0.97 },
        5: { long: 1.04, short: 0.96 }
    };

    const risk = riskMultiplier[riskLevel] || riskMultiplier[2];
    return {
        long_risk: longPrice * risk.long,
        short_risk: shortPrice * risk.short
    };
}

// Utility function to process order quantity with min/max constraints
export function processOrderQuantity(orderSize, minOrderQty, qtyStep = 1) {
    // Ensure order quantity is at least the minimum required
    let processedQty = orderSize;
    if (processedQty < minOrderQty) {
        processedQty = minOrderQty;
        console.log(chalk.yellow(`Adjusted order quantity to minimum required: ${processedQty}`));
    }

    // Round to nearest qtyStep
    processedQty = Math.round(processedQty / qtyStep) * qtyStep;

    // Convert to string with appropriate decimal places
    let decimalPlaces = 0;
    if (qtyStep < 1) {
        decimalPlaces = qtyStep.toString().split(".")[1]?.length || 0;
    }

    return processedQty.toFixed(decimalPlaces).toString();
}

// Utility function to handle blacklist/whitelist filtering
export function shouldProcessPair(pair, blacklist, whitelist) {
    const blacklistPairs = blacklist ? blacklist.replace(/\s+/g, '').split(',') : [];
    const whitelistPairs = whitelist ? whitelist.replace(/\s+/g, '').split(',') : [];

    // Check if pair is blacklisted
    if (blacklistPairs.includes(pair)) {
        return false;
    }

    // Check whitelist if enabled
    if (whitelistPairs.length > 0) {
        return whitelistPairs.includes(pair);
    }

    return true;
}

// Utility function to calculate bot uptime
export function calculateBotUptime(uptimeSeconds) {
    var elapsedDays = uptimeSeconds / 86400;  //days
    var restSeconds = uptimeSeconds % 86400;   // rest of seconds left
    var elapsedHours = restSeconds / 3600;          // hours
    restSeconds = restSeconds % 3600;
    var elapsedMinutes = restSeconds / 60;          // minutes
    var elapsedSeconds = restSeconds % 60;
    var times = [parseInt(elapsedDays), parseInt(elapsedHours), parseInt(elapsedMinutes), parseInt(elapsedSeconds)];
    return times;
}

// Utility function to validate position data and extract entry price
export function validatePositionData(symbol, position) {
    const entryPrice = position.avgPrice || position.entry_price || position.entryPrice;

    if (!position || !entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
        logIT(`Invalid position data for ${symbol}. Entry price: ${entryPrice}, Full position: ${JSON.stringify(position, null, 2)}`, LOG_LEVEL.ERROR);
        return null;
    }

    const parsedEntryPrice = parseFloat(entryPrice);
    if (isNaN(parsedEntryPrice) || parsedEntryPrice <= 0) {
        logIT(`Invalid entry price conversion for ${symbol}. Entry price: ${parsedEntryPrice}, Type: ${typeof parsedEntryPrice}`, LOG_LEVEL.ERROR);
        return null;
    }

    // Update position with the correct entry_price property
    position.entry_price = parsedEntryPrice;

    return { position, entryPrice: parsedEntryPrice };
}

// Utility function to parse and validate trading configuration
export function validateTradingConfig() {
    const takeProfitPercent = parseFloat(process.env.TAKE_PROFIT_PERCENT);

    if (isNaN(takeProfitPercent) || takeProfitPercent <= 0) {
        logIT(`Invalid take profit percentage. Take profit: ${takeProfitPercent}%`, LOG_LEVEL.ERROR);
        return null;
    }

    const useStopLoss = process.env.USE_STOPLOSS.toLowerCase() === "true";
    let stopLossPercent = null;

    if (useStopLoss) {
        stopLossPercent = parseFloat(process.env.STOP_LOSS_PERCENT);
        if (isNaN(stopLossPercent) || stopLossPercent <= 0) {
            logIT(`Invalid stop loss percentage. Stop loss: ${stopLossPercent}%`, LOG_LEVEL.ERROR);
            return null;
        }
    }

    return { takeProfitPercent, useStopLoss, stopLossPercent };
}

// Utility function to calculate TP/SL prices based on position side
export function calculateProfitLossPrices(entryPrice, side, takeProfitPercent, stopLossPercent, useStopLoss) {
    let takeProfit, stopLoss;

    if (side === "Buy") {
        takeProfit = entryPrice + (entryPrice * (takeProfitPercent / 100));
        if (useStopLoss) {
            stopLoss = entryPrice - (entryPrice * (stopLossPercent / 100));
        }
    } else {
        takeProfit = entryPrice - (entryPrice * (takeProfitPercent / 100));
        if (useStopLoss) {
            stopLoss = entryPrice + (entryPrice * (stopLossPercent / 100));
        }
    }

    // Validate calculated prices
    if (isNaN(takeProfit) || takeProfit <= 0 || (useStopLoss && (isNaN(stopLoss) || stopLoss <= 0))) {
        console.log(chalk.red(`Invalid calculated prices. Take profit: ${takeProfit}, Stop loss: ${stopLoss}`));
        return null;
    }

    // Additional validation: Ensure TP/SL prices are logical for the position side
    if (side === "Buy") {
        if (takeProfit <= entryPrice) {
            console.log(chalk.red(`Invalid take profit price for Buy position: TP (${takeProfit}) should be greater than entry price (${entryPrice})`));
            return null;
        }
        if (useStopLoss && stopLoss >= entryPrice) {
            console.log(chalk.red(`Invalid stop loss price for Buy position: SL (${stopLoss}) should be less than entry price (${entryPrice})`));
            return null;
        }
    } else {
        if (takeProfit >= entryPrice) {
            console.log(chalk.red(`Invalid take profit price for Sell position: TP (${takeProfit}) should be less than entry price (${entryPrice})`));
            return null;
        }
        if (useStopLoss && stopLoss <= entryPrice) {
            console.log(chalk.red(`Invalid stop loss price for Sell position: SL (${stopLoss}) should be greater than entry price (${entryPrice})`));
            return null;
        }
    }

    return { takeProfit, stopLoss };
}

// Utility function to get tick data for a symbol
export function getTickData(symbol) {
    try {
        const tickData = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));
        const index = tickData.findIndex(x => x.pair === symbol);

        if (index === -1) {
            console.log(chalk.red(`No tick data found for ${symbol}`));
            return null;
        }

        return {
            tickSize: tickData[index].tickSize,
            decimalPlaces: (tickData[index].tickSize.toString().split(".")[1] || []).length
        };
    } catch (error) {
        logIT(`Error reading tick data for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
        return null;
    }
}

// Utility function to format price with correct decimal places
export function formatPrice(price, decimalPlaces) {
    try {
        // Ensure price is a valid number
        const numericPrice = parseFloat(price);
        if (isNaN(numericPrice) || numericPrice <= 0) {
            console.log(chalk.red(`Invalid price for formatting: ${price}`));
            return "0";
        }

        // Ensure decimalPlaces is a valid integer
        const validDecimalPlaces = parseInt(decimalPlaces) || 6;

        // Format the price
        const formattedPrice = numericPrice.toFixed(validDecimalPlaces);

        // Log extreme prices that might indicate formatting issues
        if (numericPrice > 1000000) {
            console.log(chalk.yellow(`Warning: Large price detected: ${numericPrice} -> ${formattedPrice}`));
        }

        return formattedPrice;
    } catch (error) {
        console.log(chalk.red(`Error formatting price ${price}: ${error.message}`));
        return "0";
    }
}

// Utility function to check if TP/SL update is needed
export function needsTpSlUpdate(position, takeProfit) {
    return position.size > 0 && (position.take_profit === 0 || takeProfit !== position.take_profit);
}

// Utility function to set TP/SL via API
export async function setTradingStopAPI(restClient, symbol, takeProfitStr, stopLossStr, positionIdx) {
    const params = {
        category: 'linear',
        symbol: symbol,
        takeProfit: takeProfitStr,
        positionIdx: positionIdx
    };

    if (stopLossStr) {
        params.stopLoss = stopLossStr;
    }

    return await restClient.setTradingStop(params);
}

// Utility function to handle price adjustment for fast-moving markets
export async function adjustPriceForFastMarket(restClient, symbol, side, decimalPlaces) {
    try {
        const priceFetch = await restClient.getTickers({ category: 'linear', symbol: symbol });
        let price;

        if (side === "Sell") {
            price = parseFloat(priceFetch.result.list[0].ask1Price);
        } else {
            price = parseFloat(priceFetch.result.list[0].bid1Price);
        }

        return price.toFixed(decimalPlaces);
    } catch (error) {
        logIT(`Error adjusting price for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
        return null;
    }
}

// Utility function to handle API response for TP/SL operations
export function handleTpSlResponse(order, symbol, useStopLoss) {
    if (order.retMsg === "OK" || order.retMsg === "not modified" || order.retCode === 10002 || order.retCode === 130024) {
        return { success: true, needsRetry: false };
    }

    // Handle fast-moving market errors
    if (order.retCode === 130027 || order.retCode === 130030 || order.retCode === 130024) {
        return { success: false, needsRetry: true, error: "Price moving too fast" };
    }

    // Handle other errors
    return { success: false, needsRetry: false, error: order.retMsg || "Unknown error" };
}
