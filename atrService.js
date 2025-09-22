/**
 * ATR Service - Average True Range Calculation Engine
 * Provides ATR calculations for Scaled ATR DCA system
 */

import { logIT, LOG_LEVEL } from './log.js';
import DataPersistence from './dataPersistence.js';

class ATRService {
    constructor(restClient) {
        this.restClient = restClient;
        this.dataPersistence = new DataPersistence();

        // Load persistent cache first, then initialize empty cache
        this.atrCache = this.dataPersistence.loadATRCache();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache
        this.defaultConfig = {
            timeframe: '1h',
            length: 14,
            timeout: 10000 // 10 seconds timeout
        };
    }

    /**
     * Calculate ATR for a specific symbol and configuration
     * @param {string} symbol - Trading pair symbol (e.g., 'BTCUSDT')
     * @param {Object} config - ATR configuration
     * @returns {Promise<number|null>} - ATR value or null if failed
     */
    async calculateATR(symbol, config = {}) {
        const finalConfig = { ...this.defaultConfig, ...config };
        const cacheKey = this.generateCacheKey(symbol, finalConfig);

        // Check cache first
        const cachedATR = this.getFromCache(cacheKey);
        if (cachedATR !== null) {
            logIT(`Using cached ATR for ${symbol}: ${cachedATR}`, LOG_LEVEL.DEBUG);
            return cachedATR;
        }

        try {
            logIT(`Calculating ATR for ${symbol} (${finalConfig.timeframe}, ${finalConfig.length})`, LOG_LEVEL.INFO);

            // Fetch kline data from Bybit V5
            const klines = await this.fetchKlineData(symbol, finalConfig);

            if (!klines || klines.length < finalConfig.length + 1) {
                throw new Error(`Insufficient kline data: received ${klines?.length || 0}, need ${finalConfig.length + 1}`);
            }

            // Calculate ATR using Wilder's smoothing method
            const atr = this.computeATR(klines, finalConfig.length);

            if (atr && atr > 0) {
                // Cache the result
                this.setToCache(cacheKey, atr);
                logIT(`ATR calculated for ${symbol}: ${atr}`, LOG_LEVEL.INFO);
                return atr;
            } else {
                throw new Error(`Invalid ATR calculation result: ${atr}`);
            }

        } catch (error) {
            logIT(`Failed to calculate ATR for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
            return null;
        }
    }

    /**
     * Generate cache key for ATR values
     */
    generateCacheKey(symbol, config) {
        return `${symbol}_${config.timeframe}_${config.length}`;
    }

    /**
     * Get ATR value from cache
     */
    getFromCache(cacheKey) {
        if (this.atrCache.has(cacheKey)) {
            const cached = this.atrCache.get(cacheKey);
            if (Date.now() - cached.timestamp < this.cacheTimeout) {
                return cached.value;
            } else {
                // Remove expired cache entry
                this.atrCache.delete(cacheKey);
            }
        }
        return null;
    }

    /**
     * Set ATR value to cache
     */
    setToCache(cacheKey, atrValue) {
        this.atrCache.set(cacheKey, {
            value: atrValue,
            timestamp: Date.now()
        });

        // Save cache to persistent storage
        this.dataPersistence.saveATRCache(this.atrCache);
    }

    /**
     * Fetch kline data from Bybit V5 API
     */
    async fetchKlineData(symbol, config) {
        try {
            const interval = this.mapTimeframe(config.timeframe);
            const limit = config.length + 1; // Need one extra for previous close

            // Try different categories in order of preference
            const categories = ['linear'];
            let lastError = null;

            for (const category of categories) {
                try {
                    logIT(`Trying ${category} category for ${symbol}`, LOG_LEVEL.DEBUG);

                    const response = await this.restClient.getKline({
                        category: category,
                        symbol: symbol,
                        interval: interval,
                        limit: limit
                    });

                    if (response.retCode === 0 && response.result?.list) {
                        // Bybit returns data in descending order (newest first), so reverse for chronological order
                        const klines = response.result.list.reverse();
                        logIT(`Fetched ${klines.length} klines for ${symbol} from ${category} category`, LOG_LEVEL.INFO);
                        return klines;
                    } else {
                        logIT(`${category} category failed for ${symbol}: ${response.retMsg}`, LOG_LEVEL.DEBUG);
                        lastError = new Error(`API Error: ${response.retMsg || 'Unknown error'}`);
                    }
                } catch (error) {
                    logIT(`${category} category error for ${symbol}: ${error.message}`, LOG_LEVEL.DEBUG);
                    lastError = error;
                }
            }

            // If all categories failed, throw the last error
            throw lastError || new Error(`All categories failed for ${symbol}`);

        } catch (error) {
            logIT(`Error fetching kline data for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
            throw error;
        }
    }

    /**
     * Map timeframe string to Bybit interval
     */
    mapTimeframe(timeframe) {
        const mapping = {
            '1m': '1',
            '5m': '5',
            '15m': '15',
            '30m': '30',
            '1h': '60',
            '4h': '240',
            '1d': 'D',
            '1w': 'W'
        };
        const result = mapping[timeframe] || '60';
        logIT(`Mapped timeframe ${timeframe} to interval ${result}`, LOG_LEVEL.DEBUG);
        return result;
    }

    /**
     * Compute ATR using Wilder's smoothing method
     * Kline format: [timestamp, open, high, low, close, volume, turnover]
     */
    computeATR(klines, period) {
        try {
            if (klines.length < period + 1) {
                throw new Error(`Insufficient data for ATR calculation: need ${period + 1}, got ${klines.length}`);
            }

            const trValues = [];

            // Calculate True Range for each candle
            for (let i = 1; i < klines.length; i++) {
                const high = parseFloat(klines[i][2]); // High price
                const low = parseFloat(klines[i][3]);  // Low price
                const prevClose = parseFloat(klines[i-1][4]); // Previous close

                const tr = Math.max(
                    high - low,
                    Math.abs(high - prevClose),
                    Math.abs(low - prevClose)
                );

                trValues.push(tr);
            }

            if (trValues.length < period) {
                throw new Error(`Insufficient TR values: need ${period}, got ${trValues.length}`);
            }

            // Calculate ATR with Wilder's smoothing method
            let atr = trValues[0]; // Start with first TR value

            for (let i = 1; i < trValues.length; i++) {
                atr = (atr * (period - 1) + trValues[i]) / period;
            }

            logIT(`ATR computed: ${atr} (period: ${period}, data points: ${trValues.length})`, LOG_LEVEL.DEBUG);
            return atr;

        } catch (error) {
            logIT(`Error computing ATR: ${error.message}`, LOG_LEVEL.ERROR);
            throw error;
        }
    }

    /**
     * Get multiple ATR values for different timeframes
     */
    async getMultipleATRs(symbol, timeframes = ['1h', '4h', '1d'], length = 14) {
        const results = {};

        for (const timeframe of timeframes) {
            try {
                const atr = await this.calculateATR(symbol, { timeframe, length });
                results[timeframe] = atr;
            } catch (error) {
                logIT(`Failed to get ${timeframe} ATR for ${symbol}: ${error.message}`, LOG_LEVEL.WARNING);
                results[timeframe] = null;
            }
        }

        return results;
    }

    /**
     * Clear ATR cache
     */
    clearCache() {
        this.atrCache.clear();
        logIT('ATR cache cleared', LOG_LEVEL.INFO);
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        const now = Date.now();
        let validEntries = 0;
        let expiredEntries = 0;

        for (const [key, value] of this.atrCache.entries()) {
            if (now - value.timestamp < this.cacheTimeout) {
                validEntries++;
            } else {
                expiredEntries++;
            }
        }

        return {
            totalEntries: this.atrCache.size,
            validEntries,
            expiredEntries,
            cacheTimeout: this.cacheTimeout
        };
    }

    /**
     * Validate ATR configuration
     */
    validateConfig(config) {
        const validTimeframes = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];
        const errors = [];

        if (config.timeframe && !validTimeframes.includes(config.timeframe)) {
            errors.push(`Invalid timeframe: ${config.timeframe}. Valid options: ${validTimeframes.join(', ')}`);
        }

        if (config.length && (config.length < 1 || config.length > 100)) {
            errors.push(`Invalid length: ${config.length}. Must be between 1 and 100`);
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Get ATR as percentage of current price
     */
    async getATRPercentage(symbol, currentPrice, config = {}) {
        const atr = await this.calculateATR(symbol, config);
        if (!atr || !currentPrice) return null;

        return (atr / currentPrice) * 100;
    }

    /**
     * Check if ATR indicates high volatility
     */
    async isHighVolatility(symbol, threshold = 2.0, config = {}) {
        try {
            const atrPercent = await this.getATRPercentage(symbol, null, config);
            if (!atrPercent) return false;

            return atrPercent > threshold;
        } catch (error) {
            logIT(`Error checking volatility for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
            return false;
        }
    }
}

export default ATRService;