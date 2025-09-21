/**
 * API Data Service - Periodic data fetching and cache management
 * Handles real-time updates for settings.json, min_order_sizes.json, and research.json
 */

import fetch from 'node-fetch';
import fs from 'fs';
import { logIT, LOG_LEVEL } from './log.js';

class APIDataService {
    constructor(restClient, discordService = null) {
        this.restClient = restClient;
        this.discordService = discordService;
        this.isUpdating = false;
        this.lastUpdate = {
            settings: 0,
            minOrderSizes: 0,
            research: 0,
            account: 0
        };
        this.updateIntervals = {
            settings: 5 * 60 * 1000, // 5 minutes
            minOrderSizes: 30 * 60 * 1000, // 30 minutes
            research: 10 * 60 * 1000, // 10 minutes
            account: 2 * 60 * 1000 // 2 minutes
        };
        this.retryAttempts = 0;
        this.maxRetries = 3;
        this.retryDelay = 5000; // 5 seconds
    }

    /**
     * Main update loop - checks if updates are needed and executes them
     */
    async updateLoop() {
        if (this.isUpdating) {
            logIT("API data update already in progress, skipping", LOG_LEVEL.DEBUG);
            return;
        }

        this.isUpdating = true;

        try {
            const now = Date.now();
            let updatesPerformed = 0;

            // Check if research data needs updating
            if (now - this.lastUpdate.research > this.updateIntervals.research) {
                await this.updateResearchData();
                this.lastUpdate.research = now;
                updatesPerformed++;
            }

            // Check if min order sizes need updating
            if (now - this.lastUpdate.minOrderSizes > this.updateIntervals.minOrderSizes) {
                await this.updateMinOrderSizes();
                this.lastUpdate.minOrderSizes = now;
                updatesPerformed++;
            }

            // Check if settings need updating
            if (now - this.lastUpdate.settings > this.updateIntervals.settings) {
                await this.updateSettings();
                this.lastUpdate.settings = now;
                updatesPerformed++;
            }

            // Check if account data needs updating
            if (now - this.lastUpdate.account > this.updateIntervals.account) {
                await this.updateAccountData();
                this.lastUpdate.account = now;
                updatesPerformed++;
            }

            if (updatesPerformed > 0) {
                logIT(`API data update completed: ${updatesPerformed} files updated`, LOG_LEVEL.INFO);
            }

        } catch (error) {
            logIT(`Error in API data update loop: ${error.message}`, LOG_LEVEL.ERROR);
            await this.handleError(error);
        } finally {
            this.isUpdating = false;
        }
    }

    /**
     * Update research data from RapidAPI
     */
    async updateResearchData() {
        try {
            logIT("Fetching research data from API", LOG_LEVEL.INFO);

            const url = "https://liquidation-report.p.rapidapi.com/lickhunterpro";
            const headers = {
                "X-RapidAPI-Key": process.env.RAPIDAPI_KEY,
                "X-RapidAPI-Host": "liquidation-report.p.rapidapi.com"
            };

            const response = await fetch(url, { headers: headers });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            // Validate data structure
            if (!data || !data.data || !Array.isArray(data.data)) {
                throw new Error("Invalid research data structure received");
            }

            // Validate each data item
            const validData = data.data.filter(item =>
                item &&
                item.name &&
                !isNaN(item.long_price) &&
                !isNaN(item.short_price) &&
                item.long_price > 0 &&
                item.short_price > 0 &&
                item.liq_volume
            );

            if (validData.length === 0) {
                throw new Error("No valid research data items found after validation");
            }

            // Save validated data
            const validatedData = { ...data, data: validData };
            fs.writeFileSync('research.json', JSON.stringify(validatedData, null, 4));

            logIT(`Research data updated successfully: ${validData.length} valid items`, LOG_LEVEL.INFO);

            // Notify Discord if enabled
            if (this.discordService && process.env.USE_DISCORD === "true") {
                await this.discordService.sendMessage(
                    `📊 Research data updated: ${validData.length} trading pairs with smart settings`,
                    'success'
                );
            }

            return true;

        } catch (error) {
            logIT(`Error updating research data: ${error.message}`, LOG_LEVEL.ERROR);

            // Fallback to existing data if available
            if (fs.existsSync('research.json')) {
                logIT("Using existing research.json as fallback", LOG_LEVEL.WARNING);
            }

            throw error;
        }
    }

    /**
     * Update minimum order sizes from Bybit API
     */
    async updateMinOrderSizes() {
        try {
            logIT("Fetching minimum order sizes from Bybit API", LOG_LEVEL.INFO);

            // Get instruments info
            const instruments = await this.restClient.getInstrumentsInfo({ category: 'linear' });
            if (!instruments?.result?.list || instruments.result.list.length === 0) {
                throw new Error("Failed to fetch instruments info");
            }

            // Get account balance
            const balance = await this.getAccountBalance();
            if (!balance) {
                throw new Error("Failed to get account balance");
            }

            // Get tickers
            const tickers = await this.restClient.getTickers({ category: 'linear' });
            if (!tickers?.result?.list || tickers.result.list.length === 0) {
                throw new Error("Failed to fetch tickers");
            }

            // Process each instrument
            const minOrderSizes = [];
            let processedCount = 0;

            for (const instrument of instruments.result.list) {
                try {
                    if (!instrument.lotSizeFilter || !instrument.priceFilter) {
                        continue;
                    }

                    const minOrderSize = parseFloat(instrument.lotSizeFilter.minOrderQty);
                    const tickSize = parseFloat(instrument.priceFilter.tickSize);

                    // Get current price
                    const ticker = tickers.result.list.find(t => t.symbol === instrument.symbol);
                    if (!ticker || !ticker.lastPrice) {
                        continue;
                    }

                    const price = parseFloat(ticker.lastPrice);
                    const usdValue = minOrderSize * price;

                    // Calculate our order size based on account parameters
                    const minOrderSizeUSD = (balance * (process.env.PERCENT_ORDER_SIZE / 100)) * process.env.LEVERAGE;
                    const finalOrderSize = minOrderSizeUSD < usdValue ? minOrderSize : (minOrderSizeUSD / price);

                    // Calculate max position size
                    const maxPositionSize = ((balance * (process.env.MAX_POSITION_SIZE_PERCENT / 100)) / price) * process.env.LEVERAGE;

                    minOrderSizes.push({
                        pair: instrument.symbol,
                        minOrderSize: parseFloat(finalOrderSize.toFixed(8)),
                        maxPositionSize: parseFloat(maxPositionSize.toFixed(8)),
                        tickSize: tickSize
                    });

                    processedCount++;

                } catch (pairError) {
                    logIT(`Error processing pair ${instrument.symbol}: ${pairError.message}`, LOG_LEVEL.DEBUG);
                    continue;
                }
            }

            if (minOrderSizes.length === 0) {
                throw new Error("No valid minimum order sizes calculated");
            }

            // Save to file
            fs.writeFileSync('min_order_sizes.json', JSON.stringify(minOrderSizes, null, 4));

            logIT(`Minimum order sizes updated: ${processedCount} pairs processed`, LOG_LEVEL.INFO);

            // Notify Discord if enabled
            if (this.discordService && process.env.USE_DISCORD === "true") {
                await this.discordService.sendMessage(
                    `📏 Minimum order sizes updated: ${processedCount} trading pairs`,
                    'success'
                );
            }

            return true;

        } catch (error) {
            logIT(`Error updating minimum order sizes: ${error.message}`, LOG_LEVEL.ERROR);
            throw error;
        }
    }

    /**
     * Update settings using research data and min order sizes
     */
    async updateSettings() {
        try {
            logIT("Updating trading settings", LOG_LEVEL.INFO);

            // Load required data files
            if (!fs.existsSync('research.json') || !fs.existsSync('min_order_sizes.json')) {
                throw new Error("Required data files not found");
            }

            const researchData = JSON.parse(fs.readFileSync('research.json', 'utf8'));
            const minOrderSizes = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));

            let currentSettings;
            try {
                currentSettings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
            } catch {
                // Create new settings if file doesn't exist or is invalid
                currentSettings = { pairs: [] };
            }

            if (!currentSettings.pairs) {
                currentSettings.pairs = [];
            }

            let updatedCount = 0;

            // Process each research item
            for (const researchItem of researchData.data) {
                try {
                    if (researchItem.name.includes("1000")) {
                        continue; // Skip 1000x pairs
                    }

                    const symbol = researchItem.name + "USDT";

                    // Find corresponding min order size data
                    const minOrderSizeData = minOrderSizes.find(m => m.pair === symbol);
                    if (!minOrderSizeData) {
                        continue;
                    }

                    // Find existing settings for this symbol
                    const existingSettings = currentSettings.pairs.find(p => p.symbol === symbol);

                    // Calculate risk-adjusted prices
                    const riskLevel = parseInt(process.env.RISK_LEVEL) || 2;
                    const riskPrices = this.calculateRiskPrices(
                        researchItem.long_price,
                        researchItem.short_price,
                        riskLevel
                    );

                    const newSettings = {
                        symbol: symbol,
                        leverage: process.env.LEVERAGE,
                        min_volume: researchItem.liq_volume,
                        take_profit: process.env.TAKE_PROFIT_PERCENT,
                        stop_loss: process.env.STOP_LOSS_PERCENT,
                        order_size: minOrderSizeData.minOrderSize,
                        max_position_size: minOrderSizeData.maxPositionSize,
                        long_price: riskPrices.long_risk,
                        short_price: riskPrices.short_risk
                    };

                    if (existingSettings) {
                        // Update existing settings
                        Object.assign(existingSettings, newSettings);
                    } else {
                        // Add new settings
                        currentSettings.pairs.push(newSettings);
                    }

                    updatedCount++;

                } catch (itemError) {
                    logIT(`Error processing research item ${researchItem.name}: ${itemError.message}`, LOG_LEVEL.DEBUG);
                    continue;
                }
            }

            // Save updated settings
            fs.writeFileSync('settings.json', JSON.stringify(currentSettings, null, 4));

            logIT(`Settings updated successfully: ${updatedCount} pairs configured`, LOG_LEVEL.INFO);

            // Notify Discord if enabled
            if (this.discordService && process.env.USE_DISCORD === "true") {
                await this.discordService.sendMessage(
                    `⚙️ Trading settings updated: ${updatedCount} pairs configured with smart settings`,
                    'success'
                );
            }

            return true;

        } catch (error) {
            logIT(`Error updating settings: ${error.message}`, LOG_LEVEL.ERROR);
            throw error;
        }
    }

    /**
     * Calculate risk-adjusted prices based on risk level
     */
    calculateRiskPrices(longPrice, shortPrice, riskLevel) {
        const multipliers = {
            1: { long: 1.005, short: 0.995 },
            2: { long: 1.01, short: 0.99 },
            3: { long: 1.02, short: 0.98 },
            4: { long: 1.03, short: 0.97 },
            5: { long: 1.04, short: 0.96 }
        };

        const mult = multipliers[riskLevel] || multipliers[2];

        return {
            long_risk: longPrice * mult.long,
            short_risk: shortPrice * mult.short
        };
    }

    /**
     * Get account balance with error handling
     */
    async getAccountBalance() {
        try {
            const data = await this.restClient.getWalletBalance({
                accountType: 'UNIFIED',
                coin: 'USDT'
            });

            if (!data?.result?.list || data.result.list.length === 0) {
                throw new Error("Invalid balance data received");
            }

            const balance = parseFloat(data.result.list[0].totalAvailableBalance);

            if (isNaN(balance) || balance < 0) {
                throw new Error(`Invalid balance value: ${balance}`);
            }

            return balance;

        } catch (error) {
            logIT(`Error getting account balance: ${error.message}`, LOG_LEVEL.ERROR);
            return null;
        }
    }

    /**
     * Handle errors with retry logic
     */
    async handleError(error) {
        this.retryAttempts++;

        if (this.retryAttempts <= this.maxRetries) {
            logIT(`API data update failed (attempt ${this.retryAttempts}/${this.maxRetries}), retrying in ${this.retryDelay/1000}s`, LOG_LEVEL.WARNING);

            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, this.retryDelay));

            // Exponential backoff
            this.retryDelay *= 2;
        } else {
            logIT(`API data update failed after ${this.maxRetries} attempts: ${error.message}`, LOG_LEVEL.ERROR);

            // Reset retry attempts
            this.retryAttempts = 0;
            this.retryDelay = 5000;

            // Send error notification to Discord if enabled
            if (this.discordService && process.env.USE_DISCORD === "true") {
                await this.discordService.sendMessage(
                    `❌ API data update failed: ${error.message}`,
                    'error'
                );
            }
        }
    }

    /**
     * Force immediate update of all data files
     */
    async forceUpdateAll() {
        logIT("Forcing immediate update of all data files", LOG_LEVEL.INFO);

        const results = {
            research: false,
            minOrderSizes: false,
            settings: false,
            account: false
        };

        try {
            results.research = await this.updateResearchData();
        } catch (error) {
            logIT(`Forced research update failed: ${error.message}`, LOG_LEVEL.ERROR);
        }

        try {
            results.minOrderSizes = await this.updateMinOrderSizes();
        } catch (error) {
            logIT(`Forced min order sizes update failed: ${error.message}`, LOG_LEVEL.ERROR);
        }

        try {
            results.settings = await this.updateSettings();
        } catch (error) {
            logIT(`Forced settings update failed: ${error.message}`, LOG_LEVEL.ERROR);
        }

        try {
            results.account = await this.updateAccountData();
        } catch (error) {
            logIT(`Forced account data update failed: ${error.message}`, LOG_LEVEL.ERROR);
        }

        return results;
    }

    /**
     * Update account data with current balance
     */
    async updateAccountData() {
        try {
            logIT("Updating account data with current balance", LOG_LEVEL.INFO);

            // Get current balance
            const balance = await this.getAccountBalance();
            if (balance === null) {
                throw new Error("Failed to get current balance");
            }

            // Load or create account data
            let accountData;
            if (fs.existsSync('account.json')) {
                accountData = JSON.parse(fs.readFileSync('account.json', 'utf8'));
            } else {
                accountData = {
                    startingBalance: 0,
                    config_set: false,
                    lastUpdated: new Date().toISOString()
                };
            }

            // Update current balance and timestamp
            accountData.currentBalance = balance;
            accountData.lastUpdated = new Date().toISOString();

            // Set starting balance if not already set
            if (accountData.startingBalance === 0 && balance > 0) {
                accountData.startingBalance = balance;
                logIT(`Account starting balance set to: ${balance} USDT`, LOG_LEVEL.INFO);
            }

            // Save updated account data
            fs.writeFileSync('account.json', JSON.stringify(accountData, null, 4));

            logIT(`Account data updated successfully. Current balance: ${balance} USDT`, LOG_LEVEL.INFO);

            return true;

        } catch (error) {
            logIT(`Error updating account data: ${error.message}`, LOG_LEVEL.ERROR);
            throw error;
        }
    }

    /**
     * Get last update timestamps
     */
    getLastUpdateInfo() {
        return {
            ...this.lastUpdate,
            now: Date.now()
        };
    }
}

export default APIDataService;