/**
 * 0xLIQD-BYBIT - Bybit V5 Liquidation Trading Bot
 * Main application entry point
 *
 * This bot monitors real-time liquidation events on Bybit and places counter-trend
 * orders with intelligent DCA, TP/SL management, and Discord notifications.
 */

// Import dependencies
import { WebsocketClient, RestClientV5 } from 'bybit-api';
import { config } from 'dotenv';
config();
import fetch from 'node-fetch';
import chalk from 'chalk';
import fs from 'fs';
import DiscordService from './discordService.js';
import moment from 'moment';
import { logIT, LOG_LEVEL, cleanupOldLogFiles } from './log.js';
import { createMarketOrder } from './order.js';
import {
    calculateRiskPrices,
    processOrderQuantity,
    shouldProcessPair,
    calculateBotUptime,
    validatePositionData,
    validateTradingConfig,
    calculateProfitLossPrices,
    getTickData,
    formatPrice,
    needsTpSlUpdate,
    setTradingStopAPI,
    adjustPriceForFastMarket,
    handleTpSlResponse
} from './utils.js';
import APIDataService from './apiDataService.js';

// Bot configuration and state
let timestampBotStart = moment(); // Bot start time for uptime calculation

const key = process.env.API_KEY;
const secret = process.env.API_SECRET;
let rateLimit = 2000; // Base rate limit between API calls
let lastReport = 0; // Timestamp for last Discord report
let isGettingBalance = false; // Prevent recursive balance calls
let isGeneratingReport = false; // Prevent recursive Discord report calls
let pairs = []; // Array of trading pairs to monitor
let liquidationOrders = []; // Cache of recent liquidation events
let lastUpdate = 0; // Timestamp for last settings update

// Initialize Discord service if enabled
const discordService = process.env.USE_DISCORD === "true" ? new DiscordService(process.env.DISCORD_URL) : null;

// Initialize API clients
const wsClient = new WebsocketClient({
    key: key,
    secret: secret,
    // Configure WebSocket for liquidation data stream
});

const restClient = new RestClientV5({
    key: key,
    secret: secret,
    testnet: false, // Use mainnet for trading
    recv_window: 5000 // Extended receive window for API calls
});

// Initialize API data service for periodic updates
const apiDataService = new APIDataService(restClient, discordService);

// Configure update intervals from environment variables
if (process.env.RESEARCH_UPDATE_INTERVAL) {
    apiDataService.updateIntervals.research = parseInt(process.env.RESEARCH_UPDATE_INTERVAL) * 60 * 1000;
}
if (process.env.MIN_ORDER_SIZE_UPDATE_INTERVAL) {
    apiDataService.updateIntervals.minOrderSizes = parseInt(process.env.MIN_ORDER_SIZE_UPDATE_INTERVAL) * 60 * 1000;
}
if (process.env.SETTINGS_UPDATE_INTERVAL) {
    apiDataService.updateIntervals.settings = parseInt(process.env.SETTINGS_UPDATE_INTERVAL) * 60 * 1000;
}
if (process.env.ACCOUNT_UPDATE_INTERVAL) {
    apiDataService.updateIntervals.account = parseInt(process.env.ACCOUNT_UPDATE_INTERVAL) * 60 * 1000;
}

// Auto-create and refresh configuration files on startup
async function initializeConfigFiles() {
    logIT("Initializing configuration files", LOG_LEVEL.INFO);

    try {
        // Auto-create/research.json if it doesn't exist
        if (!fs.existsSync('research.json')) {
            const defaultResearch = {
                success: false,
                message: "No API response - using default settings",
                data: [
                    {
                        name: "BTCUSDT",
                        price: 30000,
                        long_price: 31500,
                        short_price: 28500,
                        risk_adjusted_long_price: 31800,
                        risk_adjusted_short_price: 28200
                    },
                    {
                        name: "ETHUSDT",
                        price: 2000,
                        long_price: 2100,
                        short_price: 1900,
                        risk_adjusted_long_price: 2130,
                        risk_adjusted_short_price: 1870
                    }
                ]
            };
            fs.writeFileSync('research.json', JSON.stringify(defaultResearch, null, 4));
            console.log(chalk.yellow("Created default research.json file"));
        }

        // Auto-create account.json if it doesn't exist
        if (!fs.existsSync('account.json')) {
            const defaultAccount = {
                startingBalance: 0,
                config_set: false,
                lastUpdated: new Date().toISOString()
            };
            fs.writeFileSync('account.json', JSON.stringify(defaultAccount, null, 4));
            console.log(chalk.yellow("Created default account.json file"));
        }

        // Auto-create min_order_sizes.json if it doesn't exist
        if (!fs.existsSync('min_order_sizes.json')) {
            const defaultMinOrderSizes = [
                {
                    pair: "BTCUSDT",
                    minOrderSize: 1,
                    maxPositionSize: 50,
                    tickSize: "0.10"
                },
                {
                    pair: "ETHUSDT",
                    minOrderSize: 1,
                    maxPositionSize: 100,
                    tickSize: "0.01"
                }
            ];
            fs.writeFileSync('min_order_sizes.json', JSON.stringify(defaultMinOrderSizes, null, 4));
            console.log(chalk.yellow("Created default min_order_sizes.json file"));
        }

        // Auto-create settings.json if it doesn't exist
        if (!fs.existsSync('settings.json')) {
            const defaultSettings = {
                pairs: [
                    {
                        symbol: "BTCUSDT",
                        leverage: "20",
                        min_volume: 1500,
                        take_profit: "0.484",
                        stop_loss: "50",
                        order_size: 0.001,
                        max_position_size: 50,
                        long_price: 0.1,
                        short_price: 0.1
                    }
                ]
            };
            fs.writeFileSync('settings.json', JSON.stringify(defaultSettings, null, 4));
            console.log(chalk.yellow("Created default settings.json file"));
        }

        // Refresh files on startup using the new API data service
        console.log(chalk.blue("Refreshing configuration files with API data service..."));

        // Force initial update of all data files
        console.log("Performing initial API data refresh...");
        try {
            const updateResults = await apiDataService.forceUpdateAll();
            console.log(chalk.green(`Initial refresh completed: ${JSON.stringify(updateResults)}`));
        } catch (error) {
            console.log(chalk.yellow(`Initial refresh failed, using fallback methods: ${error.message}`));

            // Fallback to original methods if API service fails
            console.log("Refreshing min_order_sizes.json (fallback)...");
            await getMinTradingSize();

            console.log("Refreshing research.json (fallback)...");
            const researchExists = fs.existsSync('research.json');
            if (researchExists) {
                const existingResearch = JSON.parse(fs.readFileSync('research.json', 'utf8'));
                if (existingResearch.success === false) {
                    console.log("Research data is outdated or invalid, attempting to fetch new data...");
                    await createSettings();
                } else {
                    console.log("Research data is up to date");
                }
            } else {
                await createSettings();
            }

            console.log("Refreshing settings.json (fallback)...");
            const settingsExists = fs.existsSync('settings.json');
            if (!settingsExists) {
                await createSettings();
            }
        }

        // Refresh account.json
        console.log("Refreshing account.json...");
        const accountExists = fs.existsSync('account.json');
        const currentBalance = await getBalance();

        if (!accountExists || currentBalance === null) {
            const defaultAccount = {
                startingBalance: 0,
                config_set: false,
                lastUpdated: new Date().toISOString(),
                currentBalance: 0
            };
            fs.writeFileSync('account.json', JSON.stringify(defaultAccount, null, 4));
        } else {
            // Update existing account.json with current balance and timestamp
            try {
                const accountData = JSON.parse(fs.readFileSync('account.json', 'utf8'));
                accountData.currentBalance = currentBalance;
                accountData.lastUpdated = new Date().toISOString();

                // Preserve existing startingBalance and config_set values
                if (accountData.startingBalance === 0 && currentBalance > 0) {
                    accountData.startingBalance = currentBalance;
                }

                fs.writeFileSync('account.json', JSON.stringify(accountData, null, 4));
                logIT(`Account.json refreshed with current balance: ${currentBalance} USDT`, LOG_LEVEL.INFO);
            } catch (updateError) {
                logIT(`Error updating account.json: ${updateError.message}`, LOG_LEVEL.WARNING);
            }
        }

        console.log(chalk.green("✓ Configuration files initialized and refreshed successfully"));
        logIT("Configuration files initialized and refreshed", LOG_LEVEL.INFO);

    } catch (error) {
        console.error(chalk.red("Error initializing configuration files:", error.message));
        logIT("Error initializing configuration files: " + error.message, LOG_LEVEL.ERROR);
    }
}

// Initialize logging system - clean up old logs at startup
logIT("Starting 0xLIQD-BYBIT bot", LOG_LEVEL.INFO);
logIT("Initializing log management system", LOG_LEVEL.DEBUG);
cleanupOldLogFiles();

// Auto-create and refresh configuration files before starting the bot
await initializeConfigFiles();

/**
 * Handle WebSocket updates from Bybit liquidation stream
 * Processes real-time liquidation events and triggers trading logic
 */
wsClient.on('update', (data) => {
    logIT('WebSocket update received', LOG_LEVEL.DEBUG);
    const liquidationData = data.data || data;

    liquidationData.forEach(liqData => {
        const pair = liqData.s;
        const price = parseFloat(liqData.p);
        const side = liqData.S;
        const qty = parseFloat(liqData.v) * price; // Calculate USD value
        const timestamp = Math.floor(Date.now() / 1000);

        // Find or create liquidation entry for this pair
        let index = liquidationOrders.findIndex(x => x.pair === pair);
        const direction = side === "Buy" ? "Long" : "Short";

        // Skip blacklisted pairs
        if (!shouldProcessPair(pair, process.env.BLACKLIST, process.env.WHITELIST)) {
            logIT(`Ignoring liquidation for blacklisted pair: ${pair}`, LOG_LEVEL.DEBUG);
            return;
        }

        // Initialize new liquidation entry if not exists
        if (index === -1) {
            liquidationOrders.push({ pair, price, side, qty, amount: 1, timestamp });
            index = liquidationOrders.findIndex(x => x.pair === pair);
        }

        // Update existing liquidation entry
        if (index !== -1) {
            // Aggregate liquidations within 5-second window
            if (timestamp - liquidationOrders[index].timestamp <= 5) {
                liquidationOrders[index].price = price;
                liquidationOrders[index].side = side;
                liquidationOrders[index].qty = parseFloat((liquidationOrders[index].qty + qty).toFixed(2));
                liquidationOrders[index].timestamp = timestamp;
                liquidationOrders[index].amount += 1;
            } else {
                // Reset aggregation for new liquidation event
                liquidationOrders[index].price = price;
                liquidationOrders[index].side = side;
                liquidationOrders[index].qty = qty;
                liquidationOrders[index].timestamp = timestamp;
                liquidationOrders[index].amount = 1;
            }

            // Get dynamic liquidation volume threshold
            const researchData = readResearchFile();
            let dynamicLiqVolume = parseFloat(process.env.MIN_LIQUIDATION_VOLUME) || 0;

            if (researchData?.data) {
                const symbolName = pair.replace('USDT', '');
                const researchEntry = researchData.data.find(item => item.name === symbolName);
                if (researchEntry?.liq_volume) {
                    dynamicLiqVolume = researchEntry.liq_volume;
                }
            }

            // Check if liquidation volume meets threshold and execute trade
            if (liquidationOrders[index].qty > dynamicLiqVolume) {
                logIT(`Liquidation threshold met: ${liquidationOrders[index].qty} USDT > ${dynamicLiqVolume} USDT`, LOG_LEVEL.INFO);
                scalp(pair, index, liquidationOrders[index].qty, dynamicLiqVolume);
            } else {
                logIT(`Insufficient liquidation volume for ${pair}: ${liquidationOrders[index].qty} USDT (threshold: ${dynamicLiqVolume} USDT)`, LOG_LEVEL.DEBUG);
            }
        }
    });
});

// WebSocket connection lifecycle handlers
wsClient.on('open', (data) => {
    logIT(`WebSocket connection opened: ${data.wsKey}`, LOG_LEVEL.INFO);
});

wsClient.on('response', (data) => {
    logIT(`WebSocket response received: ${data.wsKey}`, LOG_LEVEL.DEBUG);
});

wsClient.on('reconnect', ({ wsKey }) => {
    logIT(`WebSocket reconnecting: ${wsKey}`, LOG_LEVEL.WARNING);
});

wsClient.on('reconnected', (data) => {
    logIT(`WebSocket reconnected: ${data?.wsKey}`, LOG_LEVEL.INFO);
});

/**
 * Start WebSocket liquidation stream for specified trading pairs
 */
async function liquidationEngine(tradingPairs) {
    logIT(`Starting liquidation stream for ${tradingPairs.length} pairs`, LOG_LEVEL.INFO);
    wsClient.subscribeV5(tradingPairs, 'linear');
}

/**
 * Get server time and handle periodic reporting
 * @returns {string} Formatted server time
 */
async function getServerTime() {
    try {
        const data = await restClient.getServerTime();
        const serverTime = new Date(data.time * 1000);
        const formattedTime = serverTime.toGMTString() + '\n' + serverTime.toLocaleString();

        // Check if periodic report is due
        const reportInterval = getReportInterval();
        if (Date.now() - lastReport > reportInterval) {
            await reportWebhook();
            lastReport = Date.now();
        }

        return formattedTime;
    } catch (error) {
        logIT(`Error getting server time: ${error.message}`, LOG_LEVEL.ERROR);
        return 'Error fetching server time';
    }
}

/**
 * Get current margin usage for positions
 * @returns {number} Total position margin in USDT
 */
async function getMargin() {
    try {
        const data = await restClient.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
        const margin = data.result.list[0].coin[0].totalPositionIM;

        // Check if periodic report is due
        const reportInterval = getReportInterval();
        if (Date.now() - lastReport > reportInterval) {
            await reportWebhook();
            lastReport = Date.now();
        }

        return margin;
    } catch (error) {
        logIT(`Error getting margin: ${error.message}`, LOG_LEVEL.ERROR);
        return 0;
    }
}

/**
 * Calculate Discord report interval in milliseconds
 * @returns {number} Interval in milliseconds
 */
function getReportInterval() {
    const intervalMinutes = parseInt(process.env.DISCORD_REPORT_INTERVAL) || 30; // 30 minutes default
    return intervalMinutes * 60 * 1000;
}

/**
 * Get available account balance and update starting balance if needed
 * @returns {number|null} Available balance in USDT or null on error
 */
async function getBalance() {
    const startTime = Date.now();
    const TIMEOUT_MS = 30000; // 30 second timeout for balance fetching

    try {
        // Prevent recursive balance calls
        if (isGettingBalance) {
            logIT("Already getting balance, skipping recursive call", LOG_LEVEL.WARNING);
            return null;
        }
        isGettingBalance = true;

        // Get wallet balance with better error handling and logging
        let balance;

        try {
            const data = await Promise.race([
                restClient.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Balance API call timeout')), TIMEOUT_MS)
                )
            ]);

            if (!data || !data.result || !data.result.list || data.result.list.length === 0) {
                throw new Error("Invalid balance data received from API");
            }

            const availableBalance = data.result.list[0].totalAvailableBalance;

            balance = parseFloat(availableBalance);

            if (isNaN(balance) || balance < 0) {
                throw new Error("Invalid balance value: " + availableBalance);
            }

        } catch (apiError) {
            if (apiError.code) {
                logIT(`API Error code: ${apiError.code}`, LOG_LEVEL.ERROR);
            }
            throw apiError;
        }

        // Update account configuration asynchronously (don't block balance return)
        try {
            const accountConfig = JSON.parse(fs.readFileSync('account.json', 'utf8'));

            // Set starting balance if not already configured
            if (accountConfig.startingBalance === 0) {
                accountConfig.startingBalance = balance;
                fs.writeFileSync('account.json', JSON.stringify(accountConfig, null, 4));
                logIT(`Starting balance set to: ${balance} USDT`, LOG_LEVEL.INFO);
            }
        } catch (fileError) {
            logIT(`Error updating account configuration: ${fileError.message}`, LOG_LEVEL.WARNING);
        }

        return balance;
    } catch (error) {
        logIT(`Error getting balance: ${error.message}`, LOG_LEVEL.ERROR);
        // For debugging, also log the full error
            return null;
    } finally {
        isGettingBalance = false;
    }
}
/**
 * Get position information for a specific trading pair and side
 * @param {string} pair - Trading pair symbol (e.g., 'BTCUSDT')
 * @param {string} side - Position side ('Buy' or 'Sell')
 * @returns {Object} Position data with calculated metrics
 */
async function getPosition(pair, side) {
    try {
        const positions = await restClient.getPositionInfo({ category: 'linear', symbol: pair });

        if (!positions?.result?.list || positions.result.list.length === 0) {
            logIT(`No positions data returned for ${pair}`, LOG_LEVEL.DEBUG);
            return { side, entryPrice: null, size: 0, percentGain: 0 };
        }

        // Look for position with matching side
        const positionIndex = positions.result.list.findIndex(x => x.side === side);

        if (positionIndex !== -1) {
            const position = positions.result.list[positionIndex];
            const size = parseFloat(position.size);

            if (size > 0) {
                // Log active position
                const unrealizedPnl = position.unrealisedPnl || 0;
                logIT(`Open ${side} position for ${pair}: ${size} contracts, PnL: ${unrealizedPnl} USDT`, LOG_LEVEL.INFO);

                // Calculate percentage gain
                const leverage = parseFloat(process.env.LEVERAGE) || 1;
                const margin = position.positionValue / leverage;
                const percentGain = margin > 0 ? (unrealizedPnl / margin) * 100 : 0;

                return {
                    side: position.side,
                    entryPrice: position.avgPrice,
                    size: size,
                    percentGain: percentGain
                };
            } else {
                return {
                    side: position.side,
                    entryPrice: position.avgPrice,
                    size: size,
                    percentGain: 0
                };
            }
        } else {
            // Check for opposite side position in hedge mode
            const oppositeSide = side === "Buy" ? "Sell" : "Buy";
            const oppositeIndex = positions.result.list.findIndex(x => x.side === oppositeSide);

            if (oppositeIndex !== -1) {
                logIT(`Found opposite side position for ${pair}: ${oppositeSide}`, LOG_LEVEL.DEBUG);
            }

            // Return no position found structure
            return { side, entryPrice: null, size: 0, percentGain: 0 };
        }
    } catch (error) {
        logIT(`Error in getPosition for ${pair}: ${error.message}`, LOG_LEVEL.ERROR);
        return { side, entryPrice: null, size: 0, percentGain: 0 };
    }
}
//take profit - Refactored with utility functions
async function takeProfit(symbol, position) {
    try {
        // Validate position data and extract entry price
        const positionData = await position;
        const validationResult = validatePositionData(symbol, positionData);
        if (!validationResult) return;

        const { position: validatedPosition, entryPrice } = validationResult;

        // Validate trading configuration
        const config = validateTradingConfig();
        if (!config) return;

        const { takeProfitPercent, useStopLoss, stopLossPercent } = config;

        // Calculate position index based on hedge mode
        const hedgeMode = isHedgeMode();
        const positionIdx = hedgeMode ? (validatedPosition.side === "Buy" ? 1 : 2) : 0;

        logIT(`Setting TP/SL for ${symbol} (${validatedPosition.side}) in ${hedgeMode ? 'hedge' : 'one-way'} mode (positionIdx: ${positionIdx})`, LOG_LEVEL.INFO);

        // Calculate TP/SL prices
        const priceCalculation = calculateProfitLossPrices(
            entryPrice,
            validatedPosition.side,
            takeProfitPercent,
            stopLossPercent,
            useStopLoss
        );
        if (!priceCalculation) return;

        const { takeProfit, stopLoss } = priceCalculation;

        // Get tick data for price formatting
        const tickData = getTickData(symbol);
        if (!tickData) return;

        const { decimalPlaces } = tickData;

        // Check if TP/SL update is needed
        if (!needsTpSlUpdate(validatedPosition, takeProfit)) {
            return;
        }

        // Format prices
        const takeProfitStr = formatPrice(takeProfit, decimalPlaces);
        const stopLossStr = useStopLoss ? formatPrice(stopLoss, decimalPlaces) : null;

        // Set TP/SL via API
        await setTpSlWithRetry(
            restClient,
            symbol,
            takeProfitStr,
            stopLossStr,
            positionIdx,
            validatedPosition.side,
            decimalPlaces,
            useStopLoss
        );

    } catch (error) {
        logIT(`Error in takeProfit for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
    }
}

// Helper function to set TP/SL with retry logic for fast-moving markets
async function setTpSlWithRetry(restClient, symbol, takeProfitStr, stopLossStr, positionIdx, side, decimalPlaces, useStopLoss) {
    try {
        // Initial attempt
        const order = await setTradingStopAPI(restClient, symbol, takeProfitStr, stopLossStr, positionIdx);
        const response = handleTpSlResponse(order, symbol, useStopLoss);

        if (response.success) {
            logIT(`TP/SL set successfully for ${symbol}`, LOG_LEVEL.INFO);
            return;
        }

        if (response.needsRetry) {
            logIT(`Retrying TP/SL for ${symbol} due to fast-moving market`, LOG_LEVEL.WARNING);

            // Adjust price for fast-moving market
            const adjustedPriceStr = await adjustPriceForFastMarket(restClient, symbol, side, decimalPlaces);
            if (adjustedPriceStr) {
                const retryOrder = await setTradingStopAPI(restClient, symbol, adjustedPriceStr, stopLossStr, positionIdx);
                const retryResponse = handleTpSlResponse(retryOrder, symbol, useStopLoss);

                if (retryResponse.success) {
                    logIT(`TP/SL set successfully on retry for ${symbol}`, LOG_LEVEL.INFO);
                    return;
                }
            }
        }

        // Log final error if all attempts failed
        if (!response.success) {
            logIT(`Failed to set TP/SL for ${symbol}: ${response.error}`, LOG_LEVEL.ERROR);
        }

    } catch (error) {
        logIT(`Error in setTpSlWithRetry for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
    }
}
//fetch how how openPositions there are
async function totalOpenPositions() {
    try {
        var positions = await restClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT' });
        var open = 0;
        if (positions.result && positions.result.list) {
            for (var i = 0; i < positions.result.list.length; i++) {
                if (positions.result.list[i].size > 0) {
                    if (open === null) {
                        open = 1;
                    }
                    else {
                        open++;
                    }
                }
            }
        }
        return open;

    }
    catch (error) {
        return null;
    }
}

// Order management functions
let orderLocks = new Map(); // To prevent race conditions

/**
 * Check all existing positions and set TP/SL for those without them
 * Called during bot startup to ensure all positions have proper risk management
 */
async function checkAndSetMissingTPSL() {
    try {
        console.log(chalk.blue("Checking for existing positions without TP/SL..."));
        logIT("Checking for existing positions without TP/SL", LOG_LEVEL.INFO);

        // Get all positions
        const positions = await restClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT' });

        if (!positions?.result?.list || positions.result.list.length === 0) {
            console.log(chalk.green("No existing positions found"));
            return;
        }

        let positionsFixed = 0;
        let positionsChecked = 0;

        for (const position of positions.result.list) {
            if (position.size > 0) { // Only check open positions
                positionsChecked++;
                const symbol = position.symbol;
                const side = position.side;

                // Check if position lacks TP or SL
                const hasTP = position.takeProfit && parseFloat(position.takeProfit) > 0;
                const hasSL = position.stopLoss && parseFloat(position.stopLoss) > 0;

                if (!hasTP || !hasSL) {
                    console.log(chalk.yellow(`Position ${symbol} (${side}) missing TP/SL - TP: ${hasTP}, SL: ${hasSL}`));
                    logIT(`Position ${symbol} (${side}) missing TP/SL - TP: ${hasTP}, SL: ${hasSL}`, LOG_LEVEL.WARNING);

                    // Get position data in correct format for takeProfit function
                    const positionData = {
                        side: side,
                        avgPrice: position.avgPrice,
                        entryPrice: position.avgPrice,
                        entry_price: position.avgPrice,
                        size: parseFloat(position.size),
                        take_profit: position.takeProfit,
                        stop_loss: position.stopLoss
                    };

                    try {
                        // Set TP/SL with safety lock
                        const success = await setSafeTPSL(symbol, positionData);
                        if (success) {
                            positionsFixed++;
                            console.log(chalk.green(`✓ TP/SL set successfully for ${symbol}`));
                            logIT(`TP/SL set successfully for ${symbol}`, LOG_LEVEL.INFO);
                        } else {
                            console.log(chalk.red(`✗ Failed to set TP/SL for ${symbol}`));
                        }
                    } catch (error) {
                        console.log(chalk.red(`✗ Error setting TP/SL for ${symbol}: ${error.message}`));
                        logIT(`Error setting TP/SL for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
                    }

                    // Small delay between TP/SL settings to avoid rate limits
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }
        }

        console.log(chalk.green(`TP/SL check completed: ${positionsFixed}/${positionsChecked} positions fixed`));
        logIT(`TP/SL check completed: ${positionsFixed}/${positionsChecked} positions fixed`, LOG_LEVEL.INFO);

    } catch (error) {
        console.log(chalk.red(`Error during TP/SL check: ${error.message}`));
        logIT(`Error during TP/SL check: ${error.message}`, LOG_LEVEL.ERROR);

        if (process.env.USE_DISCORD == "true") {
            messageWebhook(`❌ Error during startup TP/SL check: ${error.message}`, 'error');
        }
    }
}

async function setSafeTPSL(symbol, position) {
    // Acquire lock to prevent race conditions
    if (orderLocks.has(symbol)) {
        logIT(`TP/SL operation already in progress for ${symbol}, skipping`, LOG_LEVEL.WARNING);
        return false;
    }

    orderLocks.set(symbol, true);

    try {
        // Small delay to ensure no concurrent operations
        await new Promise(resolve => setTimeout(resolve, 50));

        // Call the original takeProfit function (Bybit automatically overwrites TP/SL)
        await takeProfit(symbol, position);

        return true;
    } catch (error) {
        logIT(`Error setting TP/SL for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
        return false;
    } finally {
        // Release lock
        orderLocks.delete(symbol);
    }
}

//against trend
async function scalp(pair, index, trigger_qty, liq_volume = null) {
    //check how many positions are open
    var openPositions = await totalOpenPositions();
    //make sure openPositions is less than max open positions and not null
    if (openPositions < process.env.MAX_OPEN_POSITIONS && openPositions !== null) {
        //Long liquidation
        if (liquidationOrders[index].side === "Buy") {
            const settings = await JSON.parse(fs.readFileSync('settings.json', 'utf8'));
            var settingsIndex = await settings.pairs.findIndex(x => x.symbol === pair);

            if (settingsIndex !== -1) {
                if (liquidationOrders[index].price < settings.pairs[settingsIndex].long_price) {
                    // LONG liquidation - we should go SHORT (counter-trading)
                    var position = await getPosition(pair, "Sell");

                    // In hedge mode, we always allow new positions regardless of existing positions
                    // In one-way mode, traditional logic applies
                    const hedgeMode = isHedgeMode();

                    //position.size should never be null now with the improved getPosition function
                    //no open position (size === 0) or in hedge mode - freely enter new trade
                    if (position.size === 0 || hedgeMode) {
                        //load min order size json
                        const tickData = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));
                        var tickIndex = tickData.findIndex(x => x.pair === pair);
                        if (tickIndex === -1) {
                            console.log(chalk.redBright("No tick data found for " + pair + ", skipping order"));
                            return;
                        }
                        var tickSize = tickData[tickIndex].tickSize;
                        var minOrderQty = tickData[tickIndex].minOrderSize;
                        var qtyStep = tickData[tickIndex].qtyStep || 1;
                        var orderQty = settings.pairs[settingsIndex].order_size;

                        // Process order quantity using utility function
                        orderQty = processOrderQuantity(orderQty, minOrderQty, qtyStep);

                        console.log(chalk.blue("Placing SELL order for " + pair + " with quantity: " + orderQty + " (min: " + minOrderQty + ", tickSize: " + tickSize + ")"));

                        const positionIdx = isHedgeMode() ? 2 : 0; // 2 for hedge Sell, 0 for one-way
                        const order = await createMarketOrder(restClient, pair, "Sell", orderQty, positionIdx);

                        // Check if order was successful
                        if (order.retCode === 0 && order.result) {
                            logIT(`New SHORT Order Placed for ${pair} at ${settings.pairs[settingsIndex].order_size} size`, LOG_LEVEL.INFO);
                            if (process.env.USE_DISCORD == "true") {
                                orderWebhook(pair, settings.pairs[settingsIndex].order_size, "Sell", position.size, position.percentGain, trigger_qty);
                            }

                            // Set TP/SL after initial entry
                            setTimeout(async () => {
                                try {
                                    const updatedPosition = await getPosition(pair, "Sell");
                                    if (updatedPosition.size > 0) {
                                        logIT(`Setting TP/SL after initial SHORT entry for ${pair}`, LOG_LEVEL.INFO);
                                        await setSafeTPSL(pair, updatedPosition);
                                    }
                                } catch (error) {
                                    logIT(`Error setting TP/SL after initial SHORT entry for ${pair}: ${error.message}`, LOG_LEVEL.ERROR);
                                }
                            }, 500); // Small delay to ensure order is filled
                        } else {
                            logIT(`Failed to place SHORT Order for ${pair}: ${order.retMsg} (Error Code: ${order.retCode})`, LOG_LEVEL.ERROR);
                            if (process.env.USE_DISCORD == "true") {
                                messageWebhook("Failed to place SHORT Order for " + pair + ": " + order.retMsg);
                            }
                        }


                    }
                    //existing position (size > 0) - only DCA, don't enter new trade
                    else if (position.size > 0 && process.env.USE_DCA_FEATURE == "true") {
                        const hedgeMode = isHedgeMode();
                        //only DCA if position is at a loss or in hedge mode
                        if (position.percentGain < 0 || hedgeMode) {
                            //make sure order is less than max order size
                            if ((position.size + settings.pairs[settingsIndex].order_size) < settings.pairs[settingsIndex].max_position_size) {
                                //load min order size json
                                const tickData = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));
                                var tickIndex = tickData.findIndex(x => x.pair === pair);
                                if (tickIndex === -1) {
                                    console.log(chalk.redBright("No tick data found for " + pair + ", skipping DCA order"));
                                    return;
                                }
                                var tickSize = tickData[tickIndex].tickSize;
                                var minOrderQty = tickData[tickIndex].minOrderSize;
                                var qtyStep = tickData[tickIndex].qtyStep || 1;
                                var orderQty = settings.pairs[settingsIndex].order_size;

                                // Process DCA order quantity using utility function
                                orderQty = processOrderQuantity(orderQty, minOrderQty, qtyStep);

                                console.log(chalk.blue("Placing SELL DCA order for " + pair + " with quantity: " + orderQty + " (min: " + minOrderQty + ", tickSize: " + tickSize + ")"));

                                const positionIdx = isHedgeMode() ? 2 : 0; // 2 for hedge Sell, 0 for one-way
                                const orderParams = {
                                    category: 'linear',
                                    symbol: pair,
                                    side: "Sell",
                                    orderType: "Market",
                                    qty: orderQty,
                                    reduceOnly: false  // Explicitly set to false to open new positions
                                };

                                logIT(`DCA Order parameters: ${JSON.stringify(orderParams, null, 2)}`, LOG_LEVEL.DEBUG);

                                const order = await createMarketOrder(restClient, pair, "Sell", orderQty, positionIdx);

                                // Check if order was successful
                                if (order.retCode === 0 && order.result) {
                                    console.log(chalk.bgGreenBright("SHORT DCA Order Placed for " + pair + " at " + settings.pairs[settingsIndex].order_size + " size"));
                                    if (process.env.USE_DISCORD == "true") {
                                        orderWebhook(pair, settings.pairs[settingsIndex].order_size, "Sell", position.size, position.percentGain, trigger_qty);
                                    }

                                    // Update TP/SL after DCA
                                    setTimeout(async () => {
                                        try {
                                            const updatedPosition = await getPosition(pair, "Sell");
                                            if (updatedPosition.size > 0) {
                                                logIT(`Updating TP/SL after SHORT DCA for ${pair}`, LOG_LEVEL.INFO);
                                                await setSafeTPSL(pair, updatedPosition);
                                            }
                                        } catch (error) {
                                            logIT(`Error updating TP/SL after SHORT DCA for ${pair}: ${error.message}`, LOG_LEVEL.ERROR);
                                        }
                                    }, 500); // Small delay to ensure DCA order is filled
                                } else {
                                    console.log(chalk.redBright("Failed to place SHORT DCA Order for " + pair + ": " + order.retMsg + " (Error Code: " + order.retCode + ")"));
                                    if (process.env.USE_DISCORD == "true") {
                                        messageWebhook("Failed to place SHORT DCA Order for " + pair + ": " + order.retMsg);
                                    }
                                }
                            }
                            else {
                                //max position size reached
                                console.log("Max position size reached for " + pair);
                                messageWebhook("Max position size reached for " + pair);

                            }
                        }
                        else {
                            console.log(chalk.yellow("Position is profitable, skipping DCA for " + pair));
                        }
                    }
                    else {
                        console.log(chalk.yellow("No position action taken for " + pair + " - DCA disabled or position conditions not met"));
                    }

                }
                else {
                    console.log(chalk.cyan("!! Liquidation price " + liquidationOrders[index].price + " is higher than long price " + settings.pairs[settingsIndex].long_price + " for " + pair));
                }
            }
            else {
                console.log(chalk.bgRedBright(pair + " does not exist in settings.json"));
            }

        }
        else {
            const settings = await JSON.parse(fs.readFileSync('settings.json', 'utf8'));
            var settingsIndex = await settings.pairs.findIndex(x => x.symbol === pair);
            if (settingsIndex !== -1) {
                if (liquidationOrders[index].price > settings.pairs[settingsIndex].short_price) {
                    // SHORT liquidation - we should go LONG (counter-trading)
                    var position = await getPosition(pair, "Buy");

                    //position.size should never be null now with the improved getPosition function
                    //no open position (size === 0) or in hedge mode - freely enter new trade
                    const hedgeMode = isHedgeMode();
                    if (position.size === 0 || hedgeMode) {
                        //load min order size json
                        const tickData = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));
                        var tickIndex = tickData.findIndex(x => x.pair === pair);
                        if (tickIndex === -1) {
                            console.log(chalk.redBright("No tick data found for " + pair + ", skipping order"));
                            return;
                        }
                        var tickSize = tickData[tickIndex].tickSize;
                        var minOrderQty = tickData[tickIndex].minOrderSize;
                        var qtyStep = tickData[tickIndex].qtyStep || 1;
                        var orderQty = settings.pairs[settingsIndex].order_size;

                        // Process order quantity using utility function
                        orderQty = processOrderQuantity(orderQty, minOrderQty, qtyStep);

                        console.log(chalk.blue("Placing BUY order for " + pair + " with quantity: " + orderQty + " (min: " + minOrderQty + ", tickSize: " + tickSize + ")"));

                        const positionIdx = isHedgeMode() ? 1 : 0; // 1 for hedge Buy, 0 for one-way
                        const order = await createMarketOrder(restClient, pair, "Buy", orderQty, positionIdx);

                        // Check if order was successful
                        if (order.retCode === 0 && order.result) {
                            logIT(`New LONG Order Placed for ${pair} at ${settings.pairs[settingsIndex].order_size} size`, LOG_LEVEL.INFO);
                            if (process.env.USE_DISCORD == "true") {
                                orderWebhook(pair, settings.pairs[settingsIndex].order_size, "Buy", position.size, position.percentGain, trigger_qty);
                            }

                            // Set TP/SL after initial entry
                            setTimeout(async () => {
                                try {
                                    const updatedPosition = await getPosition(pair, "Buy");
                                    if (updatedPosition.size > 0) {
                                        logIT(`Setting TP/SL after initial LONG entry for ${pair}`, LOG_LEVEL.INFO);
                                        await setSafeTPSL(pair, updatedPosition);
                                    }
                                } catch (error) {
                                    logIT(`Error setting TP/SL after initial LONG entry for ${pair}: ${error.message}`, LOG_LEVEL.ERROR);
                                }
                            }, 500); // Small delay to ensure order is filled
                        } else {
                            logIT(`Failed to place LONG Order for ${pair}: ${order.retMsg} (Error Code: ${order.retCode})`, LOG_LEVEL.ERROR);
                            if (process.env.USE_DISCORD == "true") {
                                messageWebhook("Failed to place LONG Order for " + pair + ": " + order.retMsg);
                            }
                        }
                    }
                    //existing position (size > 0) - only DCA, don't enter new trade
                    // In hedge mode, we can still open opposite positions
                    else if (position.size > 0 && process.env.USE_DCA_FEATURE == "true") {
                        //only DCA if position is at a loss or in hedge mode
                        if (position.percentGain < 0 || hedgeMode) {
                            //make sure order is less than max order size
                            if ((position.size + settings.pairs[settingsIndex].order_size) < settings.pairs[settingsIndex].max_position_size) {
                                //load min order size json
                                const tickData = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));
                                var tickIndex = tickData.findIndex(x => x.pair === pair);
                                if (tickIndex === -1) {
                                    console.log(chalk.redBright("No tick data found for " + pair + ", skipping DCA order"));
                                    return;
                                }
                                var tickSize = tickData[tickIndex].tickSize;
                                var minOrderQty = tickData[tickIndex].minOrderSize;
                                var qtyStep = tickData[tickIndex].qtyStep || 1;
                                var orderQty = settings.pairs[settingsIndex].order_size;

                                // Process DCA order quantity using utility function
                                orderQty = processOrderQuantity(orderQty, minOrderQty, qtyStep);

                                console.log(chalk.blue("Placing BUY DCA order for " + pair + " with quantity: " + orderQty + " (min: " + minOrderQty + ", tickSize: " + tickSize + ")"));

                                const positionIdx = isHedgeMode() ? 1 : 0; // 1 for hedge Buy, 0 for one-way
                                const orderParams = {
                                    category: 'linear',
                                    symbol: pair,
                                    side: "Buy",
                                    orderType: "Market",
                                    qty: orderQty,
                                    reduceOnly: false  // Explicitly set to false to open new positions
                                };

                                logIT(`DCA Order parameters: ${JSON.stringify(orderParams, null, 2)}`, LOG_LEVEL.DEBUG);

                                const order = await createMarketOrder(restClient, pair, "Buy", orderQty, positionIdx);

                                // Check if order was successful
                                if (order.retCode === 0 && order.result) {
                                    console.log(chalk.bgRedBright("LONG DCA Order Placed for " + pair + " at " + settings.pairs[settingsIndex].order_size + " size"));
                                    if (process.env.USE_DISCORD == "true") {
                                        orderWebhook(pair, settings.pairs[settingsIndex].order_size, "Buy", position.size, position.percentGain, trigger_qty);
                                    }

                                    // Update TP/SL after DCA
                                    setTimeout(async () => {
                                        try {
                                            const updatedPosition = await getPosition(pair, "Buy");
                                            if (updatedPosition.size > 0) {
                                                logIT(`Updating TP/SL after LONG DCA for ${pair}`, LOG_LEVEL.INFO);
                                                await setSafeTPSL(pair, updatedPosition);
                                            }
                                        } catch (error) {
                                            logIT(`Error updating TP/SL after LONG DCA for ${pair}: ${error.message}`, LOG_LEVEL.ERROR);
                                        }
                                    }, 500); // Small delay to ensure DCA order is filled
                                } else {
                                    console.log(chalk.redBright("Failed to place LONG DCA Order for " + pair + ": " + order.retMsg + " (Error Code: " + order.retCode + ")"));
                                    if (process.env.USE_DISCORD == "true") {
                                        messageWebhook("Failed to place LONG DCA Order for " + pair + ": " + order.retMsg);
                                    }
                                }
                            }
                            else {
                                //max position size reached
                                console.log("Max position size reached for " + pair);
                                messageWebhook("Max position size reached for " + pair);
                            }
                        }
                        else {
                            console.log(chalk.yellow("Position is profitable, skipping DCA for " + pair));
                        }
                    }
                    else {
                        console.log(chalk.yellow("No position action taken for " + pair + " - DCA disabled or position conditions not met"));
                    }

                }
                else {
                    console.log(chalk.cyan("!! Liquidation price " + liquidationOrders[index].price + " is lower than short price " + settings.pairs[settingsIndex].short_price + " for " + pair));
                }
            }
            else {
                console.log(chalk.bgCyan(pair + " does not exist in settings.json"));
            }
        }
    }
    else {
        console.log(chalk.redBright("Max Open Positions Reached!"));
    }

}
//set leverage on all pairs
async function setLeverage(pairs, leverage) {
    for (var i = 0; i < pairs.length; i++) {
        //remove "allLiquidation" from pair name
        var pair = pairs[i].replace("allLiquidation.", "");

        try {
            var maxLeverage = await checkLeverage(pair);
            var actualLeverage = leverage;

            // Use max leverage if USE_MAX_LEVERAGE is enabled
            if (process.env.USE_MAX_LEVERAGE && process.env.USE_MAX_LEVERAGE.toLowerCase() === "true") {
                actualLeverage = maxLeverage;
                logIT(`Using max leverage for ${pair}: ${actualLeverage}`, LOG_LEVEL.INFO);
            }

            const set = await restClient.setLeverage(
                {
                    category: 'linear',
                    symbol: pair,
                    buyLeverage: actualLeverage,
                    sellLeverage: actualLeverage,
                }
            );

            if (maxLeverage >= parseFloat(actualLeverage)) {
                logIT(`Leverage for ${pair} is set to ${actualLeverage}`, LOG_LEVEL.INFO);
            }
            else {
                logIT(`Unable to set leverage for ${pair} to ${actualLeverage}. Max leverage is lower than ${actualLeverage}, removing pair from settings.json`, LOG_LEVEL.WARNING);
                //remove pair from settings.json
                const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
                var settingsIndex = settings.pairs.findIndex(x => x.symbol === pair);
                if (settingsIndex !== -1) {
                    settings.pairs.splice(settingsIndex, 1);
                    fs.writeFileSync('settings.json', JSON.stringify(settings, null, 4));
                }
            }

        }
        catch (e) {
            logIT(`ERROR setting leverage for ${pair}: ${e}`, LOG_LEVEL.ERROR);
            await sleep(1000);
        }

    }

}

// Set position mode based on configuration
async function setPositionMode() {
    const hedgeMode = process.env.HEDGE_MODE === "true";
    const mode = hedgeMode ? 3 : 0; // 3 = hedge mode, 0 = one-way mode in V5

    const set = await restClient.switchPositionMode({
        category: 'linear',
        coin: "USDT",
        mode: mode
    });

    //log responses
    if (set.retCode == 0) {
        const modeName = hedgeMode ? "Hedge" : "One-way";
        logIT(`Position mode set to ${modeName}`, LOG_LEVEL.INFO);
        return true;
    }
    else {
        logIT("Unable to set position mode", LOG_LEVEL.ERROR);
        return false;
    }
}

// Set account margin mode based on configuration
async function setMarginMode() {
    try {
        const marginMode = process.env.MARGIN || 'REGULAR_MARGIN';

        // Validate margin mode
        const validModes = ['ISOLATED_MARGIN', 'REGULAR_MARGIN', 'PORTFOLIO_MARGIN'];
        if (!validModes.includes(marginMode)) {
            logIT(`Invalid margin mode: ${marginMode}. Using default REGULAR_MARGIN`, LOG_LEVEL.WARNING);
            return false;
        }

        const set = await restClient.setMarginMode(marginMode);

        if (set.retCode == 0) {
            logIT(`Account margin mode set to ${marginMode}`, LOG_LEVEL.INFO);
            return true;
        } else {
            logIT(`Unable to set margin mode to ${marginMode}: ${set.retMsg}`, LOG_LEVEL.ERROR);
            return false;
        }
    } catch (error) {
        logIT(`Error setting margin mode: ${error.message}`, LOG_LEVEL.ERROR);
        return false;
    }
}

// Check if hedge mode is enabled
function isHedgeMode() {
    return process.env.HEDGE_MODE === "true";
}

async function checkLeverage(symbol) {
    var position = await restClient.getInstrumentsInfo({ category: 'linear', symbol: symbol });
    var leverage = position.result.list[0].leverageFilter.maxLeverage ?? 0;
    return parseFloat(leverage);
}

async function getMinTradingSize() {
    try {
        console.log("Starting min order size calculation...");
        logIT("Fetching instruments info...", LOG_LEVEL.INFO);

        // Step 1: Get instruments info with error handling
        const instruments = await restClient.getInstrumentsInfo({ category: 'linear' });
        if (!instruments || !instruments.result || !instruments.result.list || instruments.result.list.length === 0) {
            throw new Error("Failed to fetch instruments info or no instruments found");
        }
        logIT(`Fetched ${instruments.result.list.length} instruments`, LOG_LEVEL.INFO);

        // Step 2: Get account balance with error handling
        logIT("Fetching account balance...", LOG_LEVEL.INFO);
        var balance = await getBalance();
        if (balance === null || balance === undefined || isNaN(balance) || balance <= 0) {
            throw new Error("Invalid balance received: " + balance);
        }
        logIT(`Account balance: ${balance} USDT`, LOG_LEVEL.INFO);

        // Step 3: Get tickers with error handling
        logIT("Fetching tickers...", LOG_LEVEL.INFO);
        var tickers = await restClient.getTickers({ category: 'linear' });
        if (!tickers || !tickers.result || !tickers.result.list || tickers.result.list.length === 0) {
            throw new Error("Failed to fetch tickers or no tickers found");
        }
        logIT(`Fetched ${tickers.result.list.length} tickers`, LOG_LEVEL.INFO);

        // Step 4: Get positions with error handling
        logIT("Fetching positions...", LOG_LEVEL.INFO);
        var positions = await restClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT' });
        if (!positions || !positions.result || !positions.result.list) {
            logIT("Warning: Failed to fetch positions, continuing with empty positions array", LOG_LEVEL.WARNING);
            positions = { result: { list: [] } };
        }
        logIT(`Fetched ${positions.result.list.length} positions`, LOG_LEVEL.INFO);

        // Step 5: Process each instrument
        var minOrderSizes = [];
        console.log("Fetching min Trading Sizes for pairs, this could take a minute...");
        let processedPairs = 0;
        let skippedPairs = 0;

        for (var i = 0; i < instruments.result.list.length; i++) {
            const instrument = instruments.result.list[i];
            try {
                // Skip invalid instruments
                if (!instrument.lotSizeFilter || !instrument.lotSizeFilter.minOrderQty || !instrument.priceFilter || !instrument.priceFilter.tickSize) {
                    logIT(`Skipping ${instrument.symbol}: invalid instrument data`, LOG_LEVEL.DEBUG);
                    skippedPairs++;
                    continue;
                }

                const minOrderSize = instrument.lotSizeFilter.minOrderQty;

                // Get price for this symbol
                const priceFetch = tickers.result.list.find(x => x.symbol === instrument.symbol);
                if (!priceFetch || !priceFetch.lastPrice || isNaN(parseFloat(priceFetch.lastPrice))) {
                    logIT(`Skipping ${instrument.symbol}: invalid price data`, LOG_LEVEL.DEBUG);
                    skippedPairs++;
                    continue;
                }
                var price = parseFloat(priceFetch.lastPrice);

                // Calculate USD value of min order size
                var usdValue = (minOrderSize * price);

                // Calculate our order size based on account parameters
                var minOrderSizeUSD = (balance * process.env.PERCENT_ORDER_SIZE / 100) * process.env.LEVERAGE;

                // Determine the actual order size to use
                if (minOrderSizeUSD < usdValue) {
                    var minOrderSizePair = minOrderSize;
                    logIT(`Using min order size for ${instrument.symbol}: ${minOrderSizePair} (USD: ${usdValue.toFixed(2)})`, LOG_LEVEL.DEBUG);
                } else {
                    var minOrderSizePair = (minOrderSizeUSD / price);
                    logIT(`Using calculated order size for ${instrument.symbol}: ${minOrderSizePair.toFixed(6)} (USD: ${minOrderSizeUSD.toFixed(2)})`, LOG_LEVEL.DEBUG);
                }

                // Find position if it exists
                var position = positions.result.list.find(x => x.symbol === instrument.symbol);

                // Calculate max position size for pair
                var maxPositionSize = ((balance * (process.env.MAX_POSITION_SIZE_PERCENT / 100)) / price) * process.env.LEVERAGE;

                // Create and store the order size data
                var minOrderSizeJson = {
                    "pair": instrument.symbol,
                    "minOrderSize": parseFloat(minOrderSizePair.toFixed(8)),
                    "maxPositionSize": parseFloat(maxPositionSize.toFixed(8)),
                    "tickSize": parseFloat(instrument.priceFilter.tickSize),
                }
                minOrderSizes.push(minOrderSizeJson);
                processedPairs++;

                // Progress reporting
                if (processedPairs % 50 === 0) {
                    logIT(`Processed ${processedPairs}/${instruments.result.list.length} pairs`, LOG_LEVEL.INFO);
                }

            } catch (pairError) {
                logIT(`Error processing pair ${instrument.symbol}: ${pairError.message}`, LOG_LEVEL.ERROR);
                skippedPairs++;
                continue;
            }
        }

        // Log final results
        logIT(`Pair processing complete: ${processedPairs} processed, ${skippedPairs} skipped`, LOG_LEVEL.INFO);

        // Step 6: Write to file
        try {
            fs.writeFileSync('min_order_sizes.json', JSON.stringify(minOrderSizes, null, 4));
            logIT(`min_order_sizes.json updated with ${minOrderSizes.length} pairs`, LOG_LEVEL.INFO);
        } catch (fileError) {
            throw new Error(`Failed to write min_order_sizes.json: ${fileError.message}`);
        }

        // Step 7: Update settings.json
        try {
            const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
            let updatedSettings = 0;

            for (var i = 0; i < minOrderSizes.length; i++) {
                var settingsIndex = settings.pairs.findIndex(x => x.symbol === minOrderSizes[i].pair);
                if (settingsIndex !== -1) {
                    settings.pairs[settingsIndex].order_size = minOrderSizes[i].minOrderSize;
                    settings.pairs[settingsIndex].max_position_size = minOrderSizes[i].maxPositionSize;
                    updatedSettings++;
                }
            }

            fs.writeFileSync('settings.json', JSON.stringify(settings, null, 4));
            logIT(`Updated ${updatedSettings} pairs in settings.json`, LOG_LEVEL.INFO);

        } catch (settingsError) {
            throw new Error(`Failed to update settings.json: ${settingsError.message}`);
        }

        logIT("Min order size calculation completed successfully", LOG_LEVEL.INFO);

    } catch (error) {
        logIT(`Error in getMinTradingSize: ${error.message}`, LOG_LEVEL.ERROR);
        // For debugging purposes, also log the error to console
          throw error;
    }
}
//get all symbols
async function getSymbols() {
    try {
        const TOPIC_NAME = 'allLiquidation';

        const allSymbolsV5ResultLinear = await restClient.getTickers({
            category: 'linear',
        });

        const allLinearSymbols = allSymbolsV5ResultLinear.result.list.map(
            (ticker) => ticker.symbol,
        );

        const allLinearTopics = allLinearSymbols.map(
            (symbol) => `${TOPIC_NAME}.${symbol}`,
        );

        return allLinearTopics;
    }
    catch {
        logIT("Error fetching symbols", LOG_LEVEL.ERROR);
        return null;
    }
}
//sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to safely read research.json file
function readResearchFile() {
    try {
        if (fs.existsSync('research.json')) {
            return JSON.parse(fs.readFileSync('research.json'));
        }
    } catch (err) {
          }
    return null;
}
//auto create settings.json file
async function createSettings() {
    await getMinTradingSize();
    await sleep(30);
    var minOrderSizes = JSON.parse(fs.readFileSync('min_order_sizes.json'));
    //get info from https://liquidation-report.p.rapidapi.com/lickhunterpro
    const url = "https://liquidation-report.p.rapidapi.com/lickhunterpro";
    const headers = {
        "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
        "X-RapidAPI-Host": "liquidation-report.p.rapidapi.com"
    };
    try {
        const res = await fetch(url, { headers: headers });
        const out = await res.json();

        // Validate data structure before saving
        if (out && out.data && Array.isArray(out.data)) {
            // Validate each data item has required fields
            const validData = out.data.filter(item =>
                item &&
                item.name &&
                !isNaN(item.long_price) &&
                !isNaN(item.short_price) &&
                item.long_price > 0 &&
                item.short_price > 0
            );

            if (validData.length > 0) {
                // Save only valid data to research.json
                const validatedOut = { ...out, data: validData };
                fs.writeFileSync('research.json', JSON.stringify(validatedOut, null, 4));
                console.log(chalk.green(`Research data saved successfully. Validated ${validData.length} out of ${out.data.length} items.`));
            } else {
                logIT("No valid research data items found after validation", LOG_LEVEL.ERROR);
            }
        } else {
            logIT("Invalid research data structure received from API", LOG_LEVEL.ERROR);
        }

        //create settings.json file with multiple pairs
        var settings = {};
        settings["pairs"] = [];
        for (var i = 0; i < out.data.length; i++) {
              //if name contains 1000 or does not end in USDT, skip
            if (out.data[i].name.includes("1000")) {
                continue;
            }
            else {
                //find index of pair in min_order_sizes.json "pair" key
                var index = minOrderSizes.findIndex(x => x.pair === out.data[i].name + "USDT");
                if (index === -1) {
                    continue;
                }
                else {
                    // Calculate risk-adjusted prices using utility function
                    const riskLevel = parseInt(process.env.RISK_LEVEL) || 2;
                    const riskPrices = calculateRiskPrices(out.data[i].long_price, out.data[i].short_price, riskLevel);
                    const long_risk = riskPrices.long_risk;
                    const short_risk = riskPrices.short_risk;

                    // Determine leverage to use in settings
                    var leverageToUse = process.env.LEVERAGE;
                    if (process.env.USE_MAX_LEVERAGE && process.env.USE_MAX_LEVERAGE.toLowerCase() === "true") {
                        var maxLeverage = await checkLeverage(out.data[i].name + "USDT");
                        leverageToUse = maxLeverage.toString();
                    }

                    var pair = {
                        "symbol": out.data[i].name + "USDT",
                        "leverage": leverageToUse,
                        "min_volume": out.data[i].liq_volume,
                        "take_profit": process.env.TAKE_PROFIT_PERCENT,
                        "stop_loss": process.env.STOP_LOSS_PERCENT,
                        "order_size": minOrderSizes[index].minOrderSize,
                        "max_position_size": minOrderSizes[index].maxPositionSize,
                        "long_price": long_risk,
                        "short_price": short_risk
                    }
                    settings["pairs"].push(pair);
                }
            }
        }
        fs.writeFileSync('settings.json', JSON.stringify(settings, null, 4));

    } catch (err) {
            logIT(`Error fetching research data: ${err}`, LOG_LEVEL.ERROR);
            // Try to use existing research.json if available
            const researchFile = readResearchFile();
            if (researchFile && researchFile.data) {
                logIT("Using existing research.json data to create settings", LOG_LEVEL.INFO);
                var settings = {};
                settings["pairs"] = [];
                for (var i = 0; i < researchFile.data.length; i++) {
                      //if name contains 1000 or does not end in USDT, skip
                    if (researchFile.data[i].name.includes("1000")) {
                        continue;
                    }
                    else {
                        //find index of pair in min_order_sizes.json "pair" key
                        var index = minOrderSizes.findIndex(x => x.pair === researchFile.data[i].name + "USDT");
                        if (index === -1) {
                            continue;
                        }
                        else {
                            // Calculate risk-adjusted prices using utility function
                            const riskLevel = parseInt(process.env.RISK_LEVEL) || 2;
                            const riskPrices = calculateRiskPrices(researchFile.data[i].long_price, researchFile.data[i].short_price, riskLevel);
                            const long_risk = riskPrices.long_risk;
                            const short_risk = riskPrices.short_risk;

                            // Determine leverage to use in settings
                            var leverageToUse = process.env.LEVERAGE;
                            if (process.env.USE_MAX_LEVERAGE && process.env.USE_MAX_LEVERAGE.toLowerCase() === "true") {
                                var maxLeverage = await checkLeverage(researchFile.data[i].name + "USDT");
                                leverageToUse = maxLeverage.toString();
                            }

                            var pair = {
                                "symbol": researchFile.data[i].name + "USDT",
                                "leverage": leverageToUse,
                                "min_volume": researchFile.data[i].liq_volume,
                                "take_profit": process.env.TAKE_PROFIT_PERCENT,
                                "stop_loss": process.env.STOP_LOSS_PERCENT,
                                "order_size": minOrderSizes[index].minOrderSize,
                                "max_position_size": minOrderSizes[index].maxPositionSize,
                                "long_price": long_risk,
                                "short_price": short_risk
                            }
                            settings["pairs"].push(pair);
                        }
                    }
                }
                fs.writeFileSync('settings.json', JSON.stringify(settings, null, 4));
            } else {
                console.log(chalk.red("No research data available. Cannot create settings."));
            }
        }
}
//update settings.json file with long_price and short_price

async function updateSettings() {
    //check if last update was more than 5 minutes ago
    if (lastUpdate == 0) {
        lastUpdate = Date.now();
    }
    else {
        var now = Date.now();
        var diff = now - lastUpdate;
        if (diff < 300000) {
            return;
        }
        else {
            lastUpdate = Date.now();
            if (process.env.UPDATE_MIN_ORDER_SIZING == "true") {
                await getMinTradingSize();
            }
            var minOrderSizes = JSON.parse(fs.readFileSync('min_order_sizes.json'));
            var settingsFile = JSON.parse(fs.readFileSync('settings.json'));
            const url = "https://liquidation-report.p.rapidapi.com/lickhunterpro";
            const headers = {
                "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
                "X-RapidAPI-Host": "liquidation-report.p.rapidapi.com"
            };
            fetch(url, { headers: headers })
                .then(res => res.json())
                .then((out) => {
                    // Validate data structure before saving
                    if (out && out.data && Array.isArray(out.data)) {
                        // Validate each data item has required fields
                        const validData = out.data.filter(item =>
                            item &&
                            item.name &&
                            !isNaN(item.long_price) &&
                            !isNaN(item.short_price) &&
                            item.long_price > 0 &&
                            item.short_price > 0
                        );

                        if (validData.length > 0) {
                            // Save only valid data to research.json
                            const validatedOut = { ...out, data: validData };
                            fs.writeFileSync('research.json', JSON.stringify(validatedOut, null, 4));
                            console.log(chalk.green(`Research data saved successfully. Validated ${validData.length} out of ${out.data.length} items.`));
                        } else {
                            logIT("No valid research data items found after validation", LOG_LEVEL.ERROR);
                        }
                    } else {
                        logIT("Invalid research data structure received from API", LOG_LEVEL.ERROR);
                    }
                    var settings = {};
                    settings["pairs"] = [];
                    for (var i = 0; i < out.data.length; i++) {
                        //find index of pair in min_order_sizes.json "pair" key
                        var index = minOrderSizes.findIndex(x => x.pair === out.data[i].name + "USDT");
                        var settingsIndex = settingsFile.pairs.findIndex(x => x.symbol === out.data[i].name + "USDT");
                        if (index === -1 || settingsIndex === 'undefined' || out.data[i].name.includes("1000")) {
                                    }
                        else {
                            // Calculate risk-adjusted prices using utility function
                            const riskLevel = parseInt(process.env.RISK_LEVEL) || 2;
                            const riskPrices = calculateRiskPrices(out.data[i].long_price, out.data[i].short_price, riskLevel);
                            const long_risk = riskPrices.long_risk;
                            const short_risk = riskPrices.short_risk;

                            // Update settings.json file
                            settingsFile.pairs[settingsIndex].long_price = long_risk;
                            settingsFile.pairs[settingsIndex].short_price = short_risk;
                        }
                    }
                    fs.writeFileSync('settings.json', JSON.stringify(settingsFile, null, 4));
                    console.log(chalk.green("Settings updated successfully with fresh API data"));
                    //if error load research.json file and update settings.json file
                }).catch(
                    err => {
                        const researchFile = readResearchFile();
                        if (researchFile && researchFile.data) {
                            console.log(chalk.yellow("Using existing research.json data to update settings"));
                            var minOrderSizes = JSON.parse(fs.readFileSync('min_order_sizes.json'));
                            var settingsFile = JSON.parse(fs.readFileSync('settings.json'));
                            var settings = {};
                            settings["pairs"] = [];
                            for (var i = 0; i < researchFile.data.length; i++) {
                                //find index of pair in min_order_sizes.json "pair" key
                                var index = minOrderSizes.findIndex(x => x.pair === researchFile.data[i].name + "USDT");
                                var settingsIndex = settingsFile.pairs.findIndex(x => x.symbol === researchFile.data[i].name + "USDT");
                                try {
                                    if (index === -1 || settingsIndex === 'undefined' || researchFile.data[i].name.includes("1000")) {
                                      }
                                    else {
                                        // Calculate risk-adjusted prices using utility function
                                        const riskLevel = parseInt(process.env.RISK_LEVEL) || 2;
                                        const riskPrices = calculateRiskPrices(researchFile.data[i].long_price, researchFile.data[i].short_price, riskLevel);
                                        const long_risk = riskPrices.long_risk;
                                        const short_risk = riskPrices.short_risk;

                                        // Update settings.json file
                                        settingsFile.pairs[settingsIndex].long_price = long_risk;
                                        settingsFile.pairs[settingsIndex].short_price = short_risk;
                                    }
                                }
                                catch (err) {
                                    console.log("Error updating " + researchFile.data[i].name + "USDT, this is likely due to not having this pair active in your settings.json file");
                                }
                            }
                            fs.writeFileSync('settings.json', JSON.stringify(settingsFile, null, 4));
                            console.log(chalk.green("Settings updated successfully with cached research data"));
                        } else {
                            console.log(chalk.red("No research data available. Cannot update settings."));
                        }
                    }
                );
        }
    }

}

//discord webhook
function orderWebhook(symbol, amount, side, position, pnl, qty) {
    if (process.env.USE_DISCORD == "true") {
        discordService.sendOrderNotification(symbol, amount, side, position, pnl, qty);
    }
}


//message webhook
function messageWebhook(message, type = 'info') {
    if (process.env.USE_DISCORD == "true") {
        try {
            discordService.sendMessage(message, type);
        }
        catch (err) {
            console.log(err);
        }
    }
}

//report webhook
async function reportWebhook() {
    if (process.env.USE_DISCORD == "true") {
        // Prevent infinite recursion
        if (isGeneratingReport) {
            console.log("Discord report already being generated, skipping to prevent infinite loop");
            return;
        }
        isGeneratingReport = true;

        // Additional safety - ensure flag gets reset even on early exit
        const safetyReset = () => {
            isGeneratingReport = false;
        };
        console.log("Starting Discord report generation...");
        const settings = JSON.parse(fs.readFileSync('account.json', 'utf8'));
        //check if starting balance is set
        if (settings.startingBalance === 0) {
            settings.startingBalance = balance;
            fs.writeFileSync('account.json', JSON.stringify(settings, null, 4));
            var startingBalance = settings.startingBalance;
        }
        else {
            var startingBalance = settings.startingBalance;
        }

        // Safety reset in case of early returns

        //get current timestamp and calculate bot uptime
        const timestampNow = moment();
        const timeUptimeInSeconds = timestampNow.diff(timestampBotStart, 'seconds');
        const times = calculateBotUptime(timeUptimeInSeconds);

        //fetch balance
        console.log("Fetching balance for report...");
        var balance = await getBalance();
        var diff = balance - startingBalance;
        var percentGain = (diff / startingBalance) * 100;
        var percentGain = percentGain.toFixed(6);
        var diff = diff.toFixed(6);
        var balance = balance.toFixed(2);
        console.log(`Balance: ${balance}, P&L: ${diff} (${percentGain}%)`);

        //fetch positions with timeout protection
        console.log("Fetching positions for report...");
        var positions;
        try {
            positions = await Promise.race([
                restClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT' }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout fetching positions')), 10000))
            ]);
            console.log(`Found ${positions.result?.list?.length || 0} positions`);
        } catch (error) {
            console.log(`Error fetching positions: ${error.message}, using empty position list`);
            positions = { result: { list: [] } };
        }
        var positionList = [];
        var openPositions = await totalOpenPositions();
        if (openPositions === null) {
            openPositions = 0;
        }
        console.log("Fetching margin and server time...");
        var marg = await getMargin();
        var time = await getServerTime();
        console.log("Processing positions...");

        //loop through positions.result.list get open symbols with size > 0 calculate pnl and to array
        for (var i = 0; i < positions.result.list.length; i++) {
            if (positions.result.list[i].size > 0) {
                try {
                    var pnl1 = positions.result.list[i].unrealisedPnl;
                    var pnl = parseFloat(pnl1).toFixed(6);
                    var symbol = positions.result.list[i].symbol;
                    var size = positions.result.list[i].size;
                    var liq = positions.result.list[i].liqPrice;
                    var size = parseFloat(size).toFixed(4);
                    var ios = positions.result.list[i].isIsolated;

                    console.log(`Processing position: ${symbol}, size: ${size}`);

                    // Get current price with timeout protection
                    var priceFetch;
                    try {
                        priceFetch = await Promise.race([
                            restClient.getTickers({ category: 'linear', symbol: symbol }),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout fetching price')), 5000))
                        ]);
                        var test = priceFetch.result.list[0].lastPrice;
                    } catch (error) {
                        console.log(`Error fetching price for ${symbol}: ${error.message}, using 0`);
                        var test = 0;
                    }

                                  let side = positions.result.list[i].side;
                    var dir = "";
                    if (side === "Buy") {
                        dir = "✅Long / ❌Short";
                    } else {
                        dir = "❌Long / ✅Short";
                    }

                    var stop_loss = positions.result.list[i].stopLoss;
                    var take_profit = positions.result.list[i].takeProfit;
                    var price = positions.result.list[i].avgPrice;
                    var fee = positions.result.list[i].occClosingFee;
                    var price = parseFloat(price).toFixed(4);
                    //calulate size in USDT
                    var usdValue = (positions.result.list[i].avgPrice * size) / process.env.LEVERAGE;
                    var position = {
                        "symbol": symbol,
                        "size": size,
                        "side": dir,
                        "sizeUSD": usdValue.toFixed(3),
                        "pnl": pnl,
                        "liq": liq,
                        "price": price,
                        "stop_loss": stop_loss,
                        "take_profit": take_profit,
                        "iso": ios,
                        "test": test,
                        "fee": parseFloat(fee).toFixed(3)
                    }
                    positionList.push(position);
                    console.log(`Added position to list: ${symbol}, P&L: ${pnl}`);
                } catch (error) {
                    console.log(`Error processing position ${symbol}: ${error.message}`);
                }
            }
        }

        const uptimeString = times[0].toString() + " days " + times[1].toString() + " hr. " + times[2].toString() + " min. " + times[3].toString() + " sec.";
        console.log(`Sending Discord report with ${positionList.length} positions...`);

        try {
            await discordService.sendReport(
                balance,
                process.env.LEVERAGE,
                marg,
                diff,
                percentGain,
                uptimeString,
                time,
                positionList,
                openPositions
            );
            console.log("Discord report sent successfully");
            safetyReset(); // Additional safety reset
        }
        catch (err) {
            console.log(chalk.red("Discord Webhook Error"));
            console.log(err);
            safetyReset(); // Safety reset on error
        }
        finally {
            isGeneratingReport = false; // Reset flag in finally block
        }
        
        console.log("Discord report generation completed");
    }
}

async function main() {
    console.log("Starting 0xLIQD-BYBIT...");
    try {
        pairs = await getSymbols();

        //load local file acccount.json with out require and see if "config_set" is true
        var account = JSON.parse(fs.readFileSync('account.json', 'utf8'));
        if (account.config_set == false) {
            // Set both position mode and margin mode on first run
            const positionModeSet = await setPositionMode();
            const marginModeSet = await setMarginMode();

            if (positionModeSet && marginModeSet) {
                //set to true and save
                account.config_set = true;
                fs.writeFileSync('account.json', JSON.stringify(account, null, 4));
                logIT("Account configuration (position and margin modes) set successfully", LOG_LEVEL.INFO);
            } else {
                logIT("Failed to set account configuration modes", LOG_LEVEL.WARNING);
            }
        }

        if (process.env.UPDATE_MIN_ORDER_SIZING == "true") {
            console.log("Updating minimum order sizes with API data service");
            await apiDataService.updateMinOrderSizes();
        }
        if (process.env.USE_SMART_SETTINGS.toLowerCase() == "true") {
            console.log("Updating settings with smart settings using API data service");
            await apiDataService.forceUpdateAll();
        }
        if (process.env.USE_SET_LEVERAGE.toLowerCase() == "true") {
            await setLeverage(pairs, process.env.LEVERAGE);
        }

        // Check and set TP/SL for existing positions
        console.log("Performing startup TP/SL check...");
        await checkAndSetMissingTPSL();

        // Send startup report notification
        if (process.env.USE_DISCORD == "true") {
            console.log("Sending startup Discord report...");
            await reportWebhook();
            logIT("Startup report sent to Discord", LOG_LEVEL.INFO);
        }
    }
    catch (err) {
        console.log(chalk.red("Error in main()"));

        console.log(err);

        if (process.env.USE_DISCORD == "true")
            messageWebhook(err);

        await sleep(10000);
    }

    // Ensure research data is available before starting liquidation engine
    if (process.env.USE_SMART_SETTINGS.toLowerCase() == "true") {
        console.log("Initial research data fetch before starting liquidation engine using API data service...");
        await apiDataService.forceUpdateAll();
    }

    await liquidationEngine(pairs);

    while (true) {
        try {
            await getBalance();

            // Use the new API data service for periodic updates
            await apiDataService.updateLoop();

            await sleep(rateLimit);
        } catch (e) {
            console.log(e);
            sleep(1000);
            rateLimit = rateLimit + 1000;
        }
    }

}

try {
    main();
}
catch (error) {
    console.log(chalk.red("Error: ", error));

    if (process.env.USE_DISCORD == "true")
        messageWebhook(error);

    main();
}
