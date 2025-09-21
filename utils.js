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
