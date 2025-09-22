/**
 * Scaled ATR DCA - Professional Dollar Cost Averaging System
 * Implements sophisticated ATR-based DCA with limit orders and mathematical scaling
 */

import { logIT, LOG_LEVEL } from './log.js';
import DataPersistence from './dataPersistence.js';
import fs from 'fs';

class ScaledATRDCA {
    constructor(restClient, atrService, config = {}) {
        this.restClient = restClient;
        this.atrService = atrService;
        this.config = this.initializeConfig(config);
        this.dataPersistence = new DataPersistence();

        // State management
        this.activePositions = new Map(); // Track DCA state per position
        this.activeOrders = new Map();     // Track active DCA orders
        this.orderCallbacks = new Map();   // Order fill callbacks
        this.positionCallbacks = new Map(); // Position event callbacks

        // Performance monitoring
        this.stats = {
            totalPositions: 0,
            totalOrders: 0,
            filledOrders: 0,
            failedOrders: 0,
            cancelledOrders: 0,
            startTime: Date.now(),
            lastUpdateTime: Date.now(),
            performanceMetrics: {
                avgOrderExecutionTime: 0,
                avgATRCalculationTime: 0,
                totalApiCalls: 0,
                cacheHitRate: 0,
                memoryUsage: 0
            }
        };

        // Performance tracking
        this.performanceTrackers = {
            orderExecutionTimes: [],
            atrCalculationTimes: [],
            apiCallCount: 0,
            cacheHits: 0,
            cacheMisses: 0
        };

        // Start performance monitoring interval
        this.startPerformanceMonitoring();

        // Load persisted data on startup
        this.loadPersistedData();

        // Validate configuration on startup
        const configErrors = this.validateConfig();
        if (configErrors.length > 0) {
          logIT(`Configuration validation errors: ${configErrors.join(', ')}`, LOG_LEVEL.ERROR);
          throw new Error(`Invalid configuration: ${configErrors.join(', ')}`);
        }
    }

    /**
     * Retry utility with exponential backoff
     */
  async retryWithBackoff(operation, maxRetries = 3, baseDelay = 1000, operationName = 'operation') {
    let attempt = 0;
    let lastError = null;

    while (attempt < maxRetries) {
      try {
        return await operation();
      } catch (error) {
        attempt++;
        lastError = error;

        if (attempt >= maxRetries) {
          logIT(`${operationName} failed after ${maxRetries} attempts: ${error.message}`, LOG_LEVEL.ERROR);
          throw error;
        }

        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.random() * 1000;
        logIT(`${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms: ${error.message}`, LOG_LEVEL.WARNING);

        await this.delay(delay);
      }
    }

    throw lastError;
  }

  /**
   * Handle API rate limiting
   */
  async handleRateLimit(error) {
    if (error.message && error.message.includes('rate limit')) {
      const delay = 5000 + Math.random() * 5000; // 5-10 seconds
      logIT(`Rate limit hit, waiting ${delay}ms`, LOG_LEVEL.WARNING);
      await this.delay(delay);
      return true;
    }
    return false;
  }

  /**
   * Validate configuration parameters
   */
  validateConfig() {
    const errors = [];

    // ATR settings validation
    if (this.config.atrLength < 1 || this.config.atrLength > 100) {
      errors.push('ATR length must be between 1 and 100');
    }

    // DCA settings validation
    if (this.config.dcaNumOrders < 1 || this.config.dcaNumOrders > 20) {
      errors.push('DCA number of orders must be between 1 and 20');
    }

    if (this.config.volumeScale < 1.0 || this.config.volumeScale > 5.0) {
      errors.push('Volume scale must be between 1.0 and 5.0');
    }

    if (this.config.stepScale < 1.0 || this.config.stepScale > 3.0) {
      errors.push('Step scale must be between 1.0 and 3.0');
    }

    // Risk management validation
    if (this.config.maxTotalPercent < 1 || this.config.maxTotalPercent > 100) {
      errors.push('Max total percent must be between 1 and 100');
    }

    return errors;
  }

    /**
     * Load persisted data on startup
     */
  async loadPersistedData() {
    try {
      // Load DCA positions
      const persistedPositions = this.dataPersistence.loadDCAPositions();
      if (persistedPositions.size > 0) {
        this.activePositions = persistedPositions;

        // Reconstruct active orders from positions
        for (const [positionId, positionState] of this.activePositions.entries()) {
          positionState.activeOrders.forEach(orderId => {
            const level = positionState.levels.find(l => l.orderId === orderId);
            if (level && level.status === 'active') {
              this.activeOrders.set(orderId, {
                positionId,
                level: level.level,
                placedTime: level.timestamp || Date.now(),
                status: 'active'
              });
            }
          });
        }

        logIT(`Loaded ${persistedPositions.size} persisted DCA positions`, LOG_LEVEL.INFO);
      }

      // Load persisted stats
      const persistedStats = this.dataPersistence.loadPerformanceStats();
      if (persistedStats) {
        this.stats = { ...this.stats, ...persistedStats };
        logIT('Loaded persisted performance statistics', LOG_LEVEL.DEBUG);
      }

    } catch (error) {
      logIT(`Error loading persisted data: ${error.message}`, LOG_LEVEL.ERROR);
    }
  }

  /**
   * Save current state to persistent storage
   */
  async savePersistedData() {
    try {
      // Save DCA positions
      this.dataPersistence.saveDCAPositions(this.activePositions);

      // Save performance stats
      this.dataPersistence.savePerformanceStats(this.stats);

    } catch (error) {
      logIT(`Error saving persisted data: ${error.message}`, LOG_LEVEL.ERROR);
    }
  }

  /**
   * Initialize configuration with defaults
   */
    initializeConfig(userConfig) {
        const defaultConfig = {
            // ATR Settings
            atrTimeframe: '1h',
            atrLength: 14,
            atrDeviation: 1.0,

            // DCA Order Settings
            dcaNumOrders: 5,
            volumeScale: 1.5,
            stepScale: 1.2,

            // Order Management
            dcaOrderType: 'LIMIT',
            expiryMinutes: 1440,

            // Risk Management
            maxTotalPercent: 25,
            minPriceDeviation: 0.5,
            triggerOnBaseFill: true,

            // Advanced Options
            reorderDelayMs: 1000,
            fillTimeoutMinutes: 60,
            partialFillHandling: true
        };

        return { ...defaultConfig, ...userConfig };
    }

    /**
     * Initialize DCA for a new position
     */
    async initializeDCAPosition(positionId, symbol, side, basePrice, baseSize) {
        try {
            logIT(`Initializing DCA for position ${positionId} (${symbol})`, LOG_LEVEL.INFO);

            // Check if there's already an active DCA position for this symbol and side
            for (const [existingPositionId, existingPosition] of this.activePositions.entries()) {
                if (existingPosition.symbol === symbol && existingPosition.side === side && existingPosition.status === 'active') {
                    logIT(`DCA already exists for ${symbol} ${side} (position ${existingPositionId}), skipping new initialization`, LOG_LEVEL.WARNING);
                    throw new Error(`DCA position already exists for ${symbol} ${side}`);
                }
            }

            // Track ATR calculation time
            const atrStartTime = Date.now();

            // Calculate ATR for the symbol with retry logic
            const atr = await this.retryWithBackoff(
                async () => {
                    const result = await this.atrService.calculateATR(symbol, {
                        timeframe: this.config.atrTimeframe,
                        length: this.config.atrLength
                    });
                    if (!result) {
                        throw new Error(`ATR calculation returned null for ${symbol}`);
                    }
                    return result;
                },
                3,
                3000,
                `Calculate ATR for ${symbol}`
            );

            // Track ATR calculation performance
            this.trackATRCalculation(atrStartTime);

            // Generate DCA levels
            const dcaLevels = this.generateDCALevels(symbol, side, basePrice, baseSize, atr);

            // Create position state
            const positionState = {
                positionId,
                symbol,
                side,
                basePrice,
                baseSize,
                atr,
                levels: dcaLevels,
                executedLevels: [],
                activeOrders: [],
                startTime: Date.now(),
                totalAllocated: baseSize,
                averageEntryPrice: basePrice,
                status: 'active'
            };

            this.activePositions.set(positionId, positionState);
            this.stats.totalPositions++;

            // Save state after initialization
            await this.savePersistedData();

            logIT(`DCA initialized for ${positionId}: ${dcaLevels.length} levels, ATR: ${atr}`, LOG_LEVEL.INFO);

            // Place first DCA order (sequential placement)
            if (this.config.triggerOnBaseFill) {
                await this.placeNextDCAOrder(positionId);
            }

            return positionState;

        } catch (error) {
            logIT(`Failed to initialize DCA for ${positionId}: ${error.message}`, LOG_LEVEL.ERROR);
            throw error;
        }
    }

    /**
     * Health check for system components
     */
  async healthCheck() {
    const health = {
      status: 'healthy',
      components: {},
      timestamp: Date.now()
    };

    try {
      // Check ATR service
      health.components.atr = {
        status: 'healthy',
        cacheStats: this.atrService.getCacheStats()
      };

      // Check data persistence
      health.components.persistence = {
        status: 'healthy',
        stats: this.dataPersistence.getDataStats()
      };

      // Check active orders
      health.components.orders = {
        status: 'healthy',
        activeOrders: this.activeOrders.size,
        activePositions: this.activePositions.size
      };

      // Validate configuration
      const configErrors = this.validateConfig();
      if (configErrors.length > 0) {
        health.components.config = {
          status: 'warning',
          errors: configErrors
        };
        health.status = 'warning';
      }

    } catch (error) {
      health.status = 'unhealthy';
      health.error = error.message;
      health.components.system = {
        status: 'error',
        error: error.message
      };
    }

    return health;
  }

  /**
     * Generate DCA order levels using scaled ATR
     */
    generateDCALevels(symbol, side, basePrice, baseSize, atr) {
        const levels = [];
        let currentDeviation = this.config.atrDeviation;
        let currentVolumeMultiplier = 1.0;

        logIT(`Generating DCA levels for ${symbol}: basePrice=${basePrice}, baseSize=${baseSize}, atr=${atr}`, LOG_LEVEL.DEBUG);

        for (let i = 1; i <= this.config.dcaNumOrders; i++) {
            const priceDeviation = currentDeviation * atr;
            const orderPrice = this.calculateOrderPrice(basePrice, priceDeviation, side);
            const orderSize = this.calculateOrderSize(baseSize, currentVolumeMultiplier);

            const level = {
                level: i,
                orderPrice: orderPrice,
                orderSize: orderSize,
                priceDeviation: priceDeviation,
                volumeMultiplier: currentVolumeMultiplier,
                deviationPercentage: (priceDeviation / basePrice) * 100,
                status: 'pending',
                orderId: null,
                timestamp: null,
                fillPrice: null,
                fillTime: null,
                filledQty: null
            };

            levels.push(level);

            // Scale for next level
            currentDeviation *= this.config.stepScale;
            currentVolumeMultiplier *= this.config.volumeScale;

            logIT(`Level ${i}: Price=${orderPrice}, Size=${orderSize}, Deviation=${level.deviationPercentage.toFixed(2)}%`, LOG_LEVEL.DEBUG);
        }

        return levels;
    }

    /**
     * Calculate order price based on deviation and direction
     */
    calculateOrderPrice(basePrice, deviation, side) {
        if (side.toLowerCase() === 'long') {
            return basePrice - deviation; // Buy lower
        } else {
            return basePrice + deviation; // Sell higher
        }
    }

    /**
     * Calculate order size with volume scaling
     * baseSize should be in coin quantity, not USDT value
     */
    calculateOrderSize(baseSize, volumeMultiplier) {
        // Direct multiplication since baseSize is now in coin quantity
        return baseSize * volumeMultiplier;
    }

    /**
     * Place next DCA order in sequence (one at a time)
     */
    async placeNextDCAOrder(positionId) {
        const positionState = this.activePositions.get(positionId);
        if (!positionState) {
            logIT(`Position not found for next DCA order: ${positionId}`, LOG_LEVEL.ERROR);
            return;
        }

        // Check if we've reached maximum orders
        if (positionState.executedLevels.length >= this.config.dcaNumOrders) {
            logIT(`Maximum DCA levels reached for ${positionId}`, LOG_LEVEL.INFO);
            await this.completeDCAPosition(positionId);
            return;
        }

        // Check if we already have an active order (sequential placement)
        if (positionState.activeOrders.length >= 1) {
            logIT(`Already have active DCA order for ${positionId}`, LOG_LEVEL.DEBUG);
            return;
        }

        // Find the next pending level
        const nextLevel = positionState.levels.find(level =>
            level.status === 'pending'
        );

        if (nextLevel) {
            try {
                logIT(`Placing next DCA order for ${positionId}: Level ${nextLevel.level}`, LOG_LEVEL.INFO);
                await this.placeDCAOrder(positionId, nextLevel);
            } catch (error) {
                logIT(`Failed to place next DCA order: ${error.message}`, LOG_LEVEL.ERROR);
            }
        } else {
            logIT(`No more pending DCA levels for ${positionId}`, LOG_LEVEL.DEBUG);
        }
    }

    /**
     * Get minimum order size for a symbol with real-time API fallback
     */
    async getOrderConstraints(symbol) {
        try {
            // First try to get from Bybit API for real-time data
            const instruments = await this.restClient.getInstrumentsInfo({
                category: 'linear',
                symbol: symbol
            });

            if (instruments.retCode === 0 && instruments.result.list && instruments.result.list.length > 0) {
                const instrument = instruments.result.list[0];
                const lotSizeFilter = instrument.lotSizeFilter;
                const priceFilter = instrument.priceFilter;

                if (lotSizeFilter && priceFilter) {
                    const realTimeConstraints = {
                        minOrderSize: parseFloat(lotSizeFilter.minOrderQty) || 0.001,
                        qtyStep: parseFloat(lotSizeFilter.qtyStep) || 0.001,
                        tickSize: parseFloat(priceFilter.tickSize) || 0.0001
                    };

                    logIT(`Using real-time constraints for ${symbol}: min=${realTimeConstraints.minOrderSize}, step=${realTimeConstraints.qtyStep}, tick=${realTimeConstraints.tickSize}`, LOG_LEVEL.DEBUG);
                    return realTimeConstraints;
                }
            }

            // Fallback to local file if API fails
            if (!fs.existsSync('min_order_sizes.json')) {
                logIT('min_order_sizes.json not found, using default constraints', LOG_LEVEL.WARNING);
                return { minOrderSize: 0.001, qtyStep: 0.001, tickSize: 0.0001 };
            }

            const tickData = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));
            const tickIndex = tickData.findIndex(x => x.pair === symbol);

            if (tickIndex === -1) {
                logIT(`No tick data found for ${symbol}, using default constraints`, LOG_LEVEL.WARNING);
                return { minOrderSize: 0.001, qtyStep: 0.001, tickSize: 0.0001 };
            }

            const data = tickData[tickIndex];
            const fallbackConstraints = {
                minOrderSize: parseFloat(data.minOrderSize) || 0.001,
                qtyStep: parseFloat(data.qtyStep) || data.minOrderSize * 0.001,
                tickSize: parseFloat(data.tickSize) || 0.0001
            };

            logIT(`Using fallback constraints for ${symbol}: min=${fallbackConstraints.minOrderSize}, step=${fallbackConstraints.qtyStep}, tick=${fallbackConstraints.tickSize}`, LOG_LEVEL.DEBUG);
            return fallbackConstraints;

        } catch (error) {
            logIT(`Error getting order constraints for ${symbol}: ${error.message}`, LOG_LEVEL.ERROR);
            return { minOrderSize: 0.001, qtyStep: 0.001, tickSize: 0.0001 };
        }
    }

    /**
     * Process order quantity to meet minimum requirements
     */
    processOrderQuantity(orderSize, constraints) {
        let processedSize = orderSize;

        // Ensure order size meets minimum requirement
        if (processedSize < constraints.minOrderSize) {
            logIT(`Order size ${processedSize} below minimum ${constraints.minOrderSize}, adjusting to minimum`, LOG_LEVEL.WARNING);
            processedSize = constraints.minOrderSize;
        }

        // Round to nearest qtyStep
        if (constraints.qtyStep > 0) {
            const steps = Math.ceil(processedSize / constraints.qtyStep);
            processedSize = steps * constraints.qtyStep;
        }

        // Ensure reasonable precision (max 8 decimal places)
        processedSize = Math.round(processedSize * 1e8) / 1e8;

        return processedSize;
    }

    formatQuantity(quantity, constraints) {
        // Round to appropriate precision based on qtyStep
        const decimals = Math.max(0, Math.ceil(-Math.log10(constraints.qtyStep)));
        return parseFloat(quantity.toFixed(decimals)).toString();
    }

    /**
     * Place a single DCA order
     */
    async placeDCAOrder(positionId, level) {
        const positionState = this.activePositions.get(positionId);
        if (!positionState) {
            logIT(`Position not found for order placement: ${positionId}`, LOG_LEVEL.ERROR);
            return;
        }

        try {
            // Get order constraints with real-time API fallback
            const constraints = await this.getOrderConstraints(positionState.symbol);

            // Validate constraints
            if (!constraints || !constraints.tickSize) {
                throw new Error(`Invalid constraints for ${positionState.symbol}: missing tickSize`);
            }

            let processedOrderSize = this.processOrderQuantity(level.orderSize, constraints);

            // Update level with processed order size
            level.orderSize = processedOrderSize;

            // Always use LIMIT orders for DCA to ensure calculated prices are used
            const deviationPercentage = Math.abs(level.deviationPercentage);
            const orderType = 'Limit'; // Force LIMIT orders for all DCA levels

            // Format price using the constraints we already have
            const formattedPrice = this.formatPriceSync(level.orderPrice, constraints);

            const orderParams = {
                category: 'linear',
                symbol: positionState.symbol,
                side: positionState.side === 'long' ? 'Buy' : 'Sell',
                orderType: orderType,
                qty: this.formatQuantity(processedOrderSize, constraints),
                price: formattedPrice,
                reduceOnly: false
            };

            logIT(`DCA price formatting: Original=${level.orderPrice}, Formatted=${formattedPrice}, TickSize=${constraints.tickSize}`, LOG_LEVEL.DEBUG);

            logIT(`DCA order validation: Original=${level.orderSize}, Processed=${processedOrderSize}, Min=${constraints.minOrderSize}, Step=${constraints.qtyStep}`, LOG_LEVEL.DEBUG);

            logIT(`Placing ${orderType} DCA order: Level ${level.level}, Deviation: ${deviationPercentage.toFixed(2)}%, Price: ${level.orderPrice}`, LOG_LEVEL.INFO);

            // Add position index for hedge mode
            if (positionState.side === 'long') {
                orderParams.positionIdx = 1; // Buy side
            } else {
                orderParams.positionIdx = 2; // Sell side
            }

            logIT(`Placing DCA order: ${JSON.stringify(orderParams, null, 2)}`, LOG_LEVEL.DEBUG);

            // Track order execution time
            const orderStartTime = Date.now();

            // Place order with retry logic
            const order = await this.retryWithBackoff(
                async () => {
                    return await this.restClient.submitOrder(orderParams);
                },
                3,
                2000,
                `Place DCA order Level ${level.level}`
            );

            // Track successful order execution
            this.trackOrderExecution(orderStartTime);

            if (order.retCode === 0) {
                level.status = 'active';
                level.orderId = order.result.orderId;
                level.timestamp = Date.now();

                positionState.activeOrders.push(level.orderId);

                // Track the order
                this.activeOrders.set(order.result.orderId, {
                    positionId,
                    level: level.level,
                    placedTime: Date.now(),
                    status: 'active'
                });

                this.stats.totalOrders++;

                // Save state after placing order
                await this.savePersistedData();

                logIT(`DCA order placed: Level ${level.level} at ${level.orderPrice} for ${level.orderSize} (ID: ${order.result.orderId})`, LOG_LEVEL.INFO);

            } else {
                throw new Error(`Order failed: ${order.retMsg} (Code: ${order.retCode})`);
            }

        } catch (error) {
            logIT(`Failed to place DCA order: ${error.message}`, LOG_LEVEL.ERROR);

            // Handle specific error types
            if (await this.handleRateLimit(error)) {
                // Retry after rate limit delay
                return this.placeDCAOrder(positionId, level);
            }

            level.status = 'failed';
            this.stats.failedOrders++;

            // Save state even on failure
            await this.savePersistedData().catch(e => {
                logIT(`Failed to save state after order failure: ${e.message}`, LOG_LEVEL.ERROR);
            });

            throw error;
        }
    }

    /**
     * Handle order fill events
     */
    async handleOrderFill(orderId, fillPrice, filledQty) {
        try {
            const orderInfo = this.activeOrders.get(orderId);
            if (!orderInfo) {
                logIT(`Order not found in active orders: ${orderId}`, LOG_LEVEL.WARNING);
                return;
            }

            const positionState = this.activePositions.get(orderInfo.positionId);
            if (!positionState) {
                logIT(`Position not found for order fill: ${orderInfo.positionId}`, LOG_LEVEL.ERROR);
                return;
            }

            const level = positionState.levels.find(l => l.level === orderInfo.level);
            if (!level) {
                logIT(`Level not found for order: ${orderId}`, LOG_LEVEL.ERROR);
                return;
            }

            // Update level status
            level.status = 'filled';
            level.fillPrice = fillPrice;
            level.filledQty = filledQty;
            level.fillTime = Date.now();

            // Update position state
            positionState.executedLevels.push(level);
            positionState.activeOrders = positionState.activeOrders.filter(id => id !== orderId);
            positionState.totalAllocated += filledQty;

            // Recalculate average entry price
            positionState.averageEntryPrice = this.calculateAverageEntryPrice(positionState);

            // Remove from active orders tracking
            this.activeOrders.delete(orderId);
            this.stats.filledOrders++;

            // Save state after order fill
            await this.savePersistedData();

            logIT(`DCA level ${level.level} filled: ${filledQty} at ${fillPrice} (Avg: ${positionState.averageEntryPrice})`, LOG_LEVEL.INFO);

            // Place next order if needed
            await this.placeNextDCAOrder(orderInfo.positionId);

            // Trigger callback if registered
            this.triggerOrderCallback(orderId, 'filled', {
                positionId: orderInfo.positionId,
                level: level.level,
                fillPrice,
                filledQty,
                averagePrice: positionState.averageEntryPrice
            });

        } catch (error) {
            logIT(`Error handling order fill: ${error.message}`, LOG_LEVEL.ERROR);
        }
    }

    /**
     * Check and place next DCA order if needed (called externally)
     */
    async checkAndPlaceNextOrder(positionId) {
        const positionState = this.activePositions.get(positionId);
        if (!positionState) {
            logIT(`Position not found: ${positionId}`, LOG_LEVEL.ERROR);
            return;
        }

        // Only place next order if we don't have an active one (sequential)
        if (positionState.activeOrders.length === 0) {
            await this.placeNextDCAOrder(positionId);
        }
    }

    /**
     * Calculate average entry price
     */
    calculateAverageEntryPrice(positionState) {
        if (positionState.executedLevels.length === 0) {
            return positionState.basePrice;
        }

        let totalValue = positionState.basePrice * positionState.baseSize;
        let totalSize = positionState.baseSize;

        for (const level of positionState.executedLevels) {
            if (level.fillPrice && level.filledQty) {
                totalValue += level.fillPrice * level.filledQty;
                totalSize += level.filledQty;
            }
        }

        return totalValue / totalSize;
    }

    /**
     * Cancel all DCA orders for a position
     */
    async cancelAllOrders(positionId) {
        const positionState = this.activePositions.get(positionId);
        if (!positionState) return;

        // Get symbol from position ID
        const symbol = positionId.split('_')[0];
        if (!symbol) {
            logIT(`Could not extract symbol from position ID: ${positionId}`, LOG_LEVEL.ERROR);
            return;
        }

        const cancelPromises = positionState.activeOrders.map(orderId =>
            this.cancelOrder(orderId, symbol)
        );

        await Promise.allSettled(cancelPromises);
    }

    /**
     * Cancel DCA order with proper cleanup
     */
    async cancelDCAOrder(positionId, orderId) {
        try {
            logIT(`Cancelling DCA order ${orderId} for position ${positionId}`, LOG_LEVEL.INFO);

            // Get symbol from position ID (format: SYMBOL_side_timestamp)
            const symbol = positionId.split('_')[0];
            if (!symbol) {
                logIT(`Could not extract symbol from position ID: ${positionId}`, LOG_LEVEL.ERROR);
                return;
            }

            // Cancel the order with symbol
            await this.cancelOrder(orderId, symbol);

            // Remove from position's active orders
            const positionState = this.activePositions.get(positionId);
            if (positionState) {
                const orderIndex = positionState.activeOrders.indexOf(orderId);
                if (orderIndex > -1) {
                    positionState.activeOrders.splice(orderIndex, 1);
                }

                // Update level status
                const level = positionState.levels.find(l => l.orderId === orderId);
                if (level) {
                    level.status = 'cancelled';
                    level.timestamp = Date.now();
                }

                // Save updated state
                this.dataPersistence.saveDCAPositions(Array.from(this.activePositions.values()));
            }

            logIT(`DCA order ${orderId} cancelled successfully`, LOG_LEVEL.INFO);
            return true;

        } catch (error) {
            logIT(`Failed to cancel DCA order ${orderId}: ${error.message}`, LOG_LEVEL.ERROR);
            return false;
        }
    }

    /**
     * Cancel a specific order with retry logic
     */
    async cancelOrder(orderId, symbol = null) {
        try {
            if (!symbol) {
                logIT(`No symbol provided for order ${orderId}, cannot cancel`, LOG_LEVEL.ERROR);
                throw new Error('Symbol required for order cancellation');
            }

            // Cancel order with retry logic
            const order = await this.retryWithBackoff(
                async () => {
                    return await this.restClient.cancelOrder({
                        category: 'linear',
                        symbol: symbol,
                        orderId: orderId
                    });
                },
                2,
                1000,
                `Cancel order ${orderId}`
            );

            if (order.retCode === 0) {
                this.activeOrders.delete(orderId);
                this.stats.cancelledOrders++;

                // Update order status in position
                for (const positionState of this.activePositions.values()) {
                    const level = positionState.levels.find(l => l.orderId === orderId);
                    if (level) {
                        level.status = 'cancelled';
                        positionState.activeOrders = positionState.activeOrders.filter(id => id !== orderId);
                    }
                }

                // Save state after cancellation
                await this.savePersistedData();

                logIT(`Order cancelled: ${orderId}`, LOG_LEVEL.INFO);
            } else {
                throw new Error(`Cancel failed: ${order.retMsg} (Code: ${order.retCode})`);
            }

        } catch (error) {
            logIT(`Failed to cancel order ${orderId}: ${error.message}`, LOG_LEVEL.ERROR);

            // Handle rate limiting
            if (await this.handleRateLimit(error)) {
                // Retry after rate limit delay
                return this.cancelOrder(orderId);
            }

            // Mark as failed to cancel but don't throw to prevent cascading failures
            for (const positionState of this.activePositions.values()) {
                const level = positionState.levels.find(l => l.orderId === orderId);
                if (level && level.status === 'active') {
                    level.status = 'cancel_failed';
                }
            }
        }
    }

    /**
     * Complete DCA position (all levels filled or max reached)
     */
    async completeDCAPosition(positionId) {
        const positionState = this.activePositions.get(positionId);
        if (!positionState) return;

        positionState.status = 'completed';
        positionState.completionTime = Date.now();

        const totalLevels = positionState.levels.length;
        const filledLevels = positionState.executedLevels.length;
        const successRate = (filledLevels / totalLevels) * 100;

        // Save state after completion
        await this.savePersistedData();

        logIT(`DCA position completed: ${positionId} (${filledLevels}/${totalLevels} levels, ${successRate.toFixed(1)}% success)`, LOG_LEVEL.INFO);

        // Trigger completion callback
        this.triggerPositionCallback(positionId, 'completed', {
            positionState,
            successRate,
            totalAllocated: positionState.totalAllocated,
            averageEntryPrice: positionState.averageEntryPrice
        });
    }

    /**
     * Register order callback
     */
    registerOrderCallback(orderId, callback) {
        this.orderCallbacks.set(orderId, callback);
    }

    /**
     * Register position callback
     */
    registerPositionCallback(positionId, callback) {
        if (!this.positionCallbacks) {
            this.positionCallbacks = new Map();
        }
        this.positionCallbacks.set(positionId, callback);
    }

    /**
     * Trigger order callback
     */
    triggerOrderCallback(orderId, event, data) {
        const callback = this.orderCallbacks.get(orderId);
        if (callback) {
            try {
                callback(event, data);
            } catch (error) {
                logIT(`Order callback error: ${error.message}`, LOG_LEVEL.ERROR);
            }
        }
    }

    /**
     * Trigger position callback
     */
    triggerPositionCallback(positionId, event, data) {
        if (!this.positionCallbacks) return;

        const callback = this.positionCallbacks.get(positionId);
        if (callback) {
            try {
                callback(event, data);
            } catch (error) {
                logIT(`Position callback error: ${error.message}`, LOG_LEVEL.ERROR);
            }
        }
    }

    /**
     * Get position status
     */
    getPositionStatus(positionId) {
        const positionState = this.activePositions.get(positionId);
        if (!positionState) return null;

        const executedLevels = positionState.executedLevels.length;
        const totalLevels = positionState.levels.length;
        const progressPercent = (executedLevels / totalLevels) * 100;

        return {
            positionId,
            symbol: positionState.symbol,
            side: positionState.side,
            status: positionState.status,
            executedLevels,
            totalLevels,
            progressPercent,
            averageEntryPrice: positionState.averageEntryPrice,
            totalAllocated: positionState.totalAllocated,
            activeOrders: positionState.activeOrders.length,
            startTime: positionState.startTime,
            atr: positionState.atr
        };
    }

    /**
     * Get all active positions
     */
    getActivePositions() {
        const positions = [];
        for (const [positionId, positionState] of this.activePositions.entries()) {
            positions.push(this.getPositionStatus(positionId));
        }
        return positions;
    }

    /**
     * Clean up completed positions older than specified days
     */
  async cleanupCompletedPositions(maxAgeDays = 7) {
    try {
      const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const positionsToRemove = [];

      for (const [positionId, positionState] of this.activePositions.entries()) {
        if (positionState.status === 'completed' &&
            positionState.completionTime &&
            (now - positionState.completionTime) > maxAge) {
          positionsToRemove.push(positionId);
        }
      }

      // Remove old completed positions
      for (const positionId of positionsToRemove) {
        this.activePositions.delete(positionId);
        logIT(`Cleaned up completed position: ${positionId}`, LOG_LEVEL.DEBUG);
      }

      if (positionsToRemove.length > 0) {
        await this.savePersistedData();
        logIT(`Cleaned up ${positionsToRemove.length} completed positions`, LOG_LEVEL.INFO);
      }

    } catch (error) {
      logIT(`Error cleaning up completed positions: ${error.message}`, LOG_LEVEL.ERROR);
    }
  }

  /**
   * Get detailed data statistics
   */
  getDataStats() {
    const stats = {
      activePositions: 0,
      completedPositions: 0,
      totalLevels: 0,
      executedLevels: 0,
      activeOrders: 0,
      avgSuccessRate: 0
    };

    let totalSuccessRate = 0;
    let completedCount = 0;

    for (const positionState of this.activePositions.values()) {
      if (positionState.status === 'active') {
        stats.activePositions++;
      } else if (positionState.status === 'completed') {
        stats.completedPositions++;
        completedCount++;
        const successRate = (positionState.executedLevels.length / positionState.levels.length) * 100;
        totalSuccessRate += successRate;
      }

      stats.totalLevels += positionState.levels.length;
      stats.executedLevels += positionState.executedLevels.length;
      stats.activeOrders += positionState.activeOrders.length;
    }

    if (completedCount > 0) {
      stats.avgSuccessRate = totalSuccessRate / completedCount;
    }

    return {
      ...stats,
      persistenceStats: this.dataPersistence.getDataStats(),
      atrCacheStats: this.atrService.getCacheStats()
    };
  }

  /**
     * Start performance monitoring
     */
  startPerformanceMonitoring() {
    // Update performance metrics every 30 seconds
    this.performanceInterval = setInterval(() => {
      this.updatePerformanceMetrics();
    }, 30000);

    logIT('Performance monitoring started', LOG_LEVEL.DEBUG);
  }

  /**
   * Stop performance monitoring
   */
  stopPerformanceMonitoring() {
    if (this.performanceInterval) {
      clearInterval(this.performanceInterval);
      this.performanceInterval = null;
      logIT('Performance monitoring stopped', LOG_LEVEL.DEBUG);
    }
  }

  /**
   * Update performance metrics
   */
  updatePerformanceMetrics() {
    try {
      const now = Date.now();

      // Calculate average order execution time
      const avgOrderExecutionTime = this.performanceTrackers.orderExecutionTimes.length > 0
        ? this.performanceTrackers.orderExecutionTimes.reduce((a, b) => a + b, 0) / this.performanceTrackers.orderExecutionTimes.length
        : 0;

      // Calculate average ATR calculation time
      const avgATRCalculationTime = this.performanceTrackers.atrCalculationTimes.length > 0
        ? this.performanceTrackers.atrCalculationTimes.reduce((a, b) => a + b, 0) / this.performanceTrackers.atrCalculationTimes.length
        : 0;

      // Calculate cache hit rate
      const totalCacheRequests = this.performanceTrackers.cacheHits + this.performanceTrackers.cacheMisses;
      const cacheHitRate = totalCacheRequests > 0
        ? (this.performanceTrackers.cacheHits / totalCacheRequests) * 100
        : 0;

      // Get memory usage
      const memoryUsage = process.memoryUsage ? process.memoryUsage().heapUsed / 1024 / 1024 : 0;

      // Update stats
      this.stats.performanceMetrics = {
        avgOrderExecutionTime: Math.round(avgOrderExecutionTime),
        avgATRCalculationTime: Math.round(avgATRCalculationTime),
        totalApiCalls: this.performanceTrackers.apiCallCount,
        cacheHitRate: Math.round(cacheHitRate * 100) / 100,
        memoryUsage: Math.round(memoryUsage * 100) / 100
      };

      this.stats.lastUpdateTime = now;

      // Clean up old tracking data (keep last 1000 entries)
      if (this.performanceTrackers.orderExecutionTimes.length > 1000) {
        this.performanceTrackers.orderExecutionTimes = this.performanceTrackers.orderExecutionTimes.slice(-1000);
      }
      if (this.performanceTrackers.atrCalculationTimes.length > 1000) {
        this.performanceTrackers.atrCalculationTimes = this.performanceTrackers.atrCalculationTimes.slice(-1000);
      }

    } catch (error) {
      logIT(`Error updating performance metrics: ${error.message}`, LOG_LEVEL.ERROR);
    }
  }

  /**
   * Track order execution time
   */
  trackOrderExecution(startTime) {
    const executionTime = Date.now() - startTime;
    this.performanceTrackers.orderExecutionTimes.push(executionTime);
    this.performanceTrackers.apiCallCount++;
  }

  /**
   * Track ATR calculation time
   */
  trackATRCalculation(startTime) {
    const calculationTime = Date.now() - startTime;
    this.performanceTrackers.atrCalculationTimes.push(calculationTime);
  }

  /**
   * Track cache hit
   */
  trackCacheHit() {
    this.performanceTrackers.cacheHits++;
  }

  /**
   * Track cache miss
   */
  trackCacheMiss() {
    this.performanceTrackers.cacheMisses++;
  }

  /**
   * Get performance report
   */
  getPerformanceReport() {
    const uptime = Date.now() - this.stats.startTime;
    const uptimeHours = uptime / (1000 * 60 * 60);

    return {
      uptime: {
        total: uptime,
        hours: Math.round(uptimeHours * 100) / 100,
        formatted: this.formatUptime(uptime)
      },
      throughput: {
        ordersPerHour: uptimeHours > 0 ? Math.round((this.stats.totalOrders / uptimeHours) * 100) / 100 : 0,
        positionsPerHour: uptimeHours > 0 ? Math.round((this.stats.totalPositions / uptimeHours) * 100) / 100 : 0
      },
      successRates: {
        orderFillRate: this.stats.totalOrders > 0 ? Math.round((this.stats.filledOrders / this.stats.totalOrders) * 10000) / 100 : 0,
        positionCompletionRate: this.stats.totalPositions > 0 ? Math.round((this.getCompletedPositionsCount() / this.stats.totalPositions) * 10000) / 100 : 0
      },
      efficiency: {
        cacheEfficiency: this.stats.performanceMetrics.cacheHitRate,
        avgExecutionTime: this.stats.performanceMetrics.avgOrderExecutionTime,
        memoryEfficiency: this.stats.performanceMetrics.memoryUsage
      },
      currentLoad: {
        activePositions: this.activePositions.size,
        activeOrders: this.activeOrders.size,
        systemLoad: this.calculateSystemLoad()
      }
    };
  }

  /**
   * Format uptime for display
   */
  formatUptime(uptimeMs) {
    const days = Math.floor(uptimeMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((uptimeMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }

  /**
   * Get completed positions count
   */
  getCompletedPositionsCount() {
    let completedCount = 0;
    for (const positionState of this.activePositions.values()) {
      if (positionState.status === 'completed') {
        completedCount++;
      }
    }
    return completedCount;
  }

  /**
   * Calculate system load indicator
   */
  calculateSystemLoad() {
    const activePositions = this.activePositions.size;
    const activeOrders = this.activeOrders.size;
    const memoryUsage = this.stats.performanceMetrics.memoryUsage;

    // Simple load calculation (0-100 scale)
    let load = 0;

    // Position load (40% weight)
    load += Math.min(activePositions * 10, 40);

    // Order load (30% weight)
    load += Math.min(activeOrders * 5, 30);

    // Memory load (30% weight)
    load += Math.min(memoryUsage / 100, 30);

    return Math.round(load);
  }

  /**
   * Optimize performance based on current load
   */
  optimizePerformance() {
    const load = this.calculateSystemLoad();
    const optimizations = [];

    if (load > 80) {
      // High load optimizations
      optimizations.push('High load detected - reducing cache refresh frequency');

      // Clear old completed positions
      this.cleanupCompletedPositions(3); // Reduce retention to 3 days

      // Reduce active orders if too many
      if (this.activeOrders.size > 10) {
        optimizations.push('Too many active orders - consider reducing dcaMaxActiveOrders');
      }
    }

    if (this.stats.performanceMetrics.cacheHitRate < 50) {
      optimizations.push('Low cache hit rate - consider increasing ATR cache timeout');
    }

    if (this.stats.performanceMetrics.avgOrderExecutionTime > 5000) {
      optimizations.push('Slow order execution - check API connectivity and rate limits');
    }

    if (optimizations.length > 0) {
      logIT(`Performance optimizations: ${optimizations.join(', ')}`, LOG_LEVEL.INFO);
    }

    return optimizations;
  }

  /**
   * Force save all data
   */
  async forceSave() {
    try {
      await this.savePersistedData();
      logIT('Force save completed', LOG_LEVEL.INFO);
    } catch (error) {
      logIT(`Force save failed: ${error.message}`, LOG_LEVEL.ERROR);
      throw error;
    }
  }

  /**
   * Get statistics
   */
    getStatistics() {
        return {
            ...this.stats,
            activePositions: this.activePositions.size,
            activeOrders: this.activeOrders.size,
            cacheStats: this.atrService?.getCacheStats()
        };
    }

    /**
     * Utility functions
     */
    formatQuantity(quantity, constraints = null) {
        if (constraints) {
            const decimals = Math.max(0, Math.ceil(-Math.log10(constraints.qtyStep)));
            return parseFloat(quantity.toFixed(decimals)).toString();
        }
        return parseFloat(quantity.toFixed(8)).toString();
    }

    formatPrice(price, symbol = null) {
        if (symbol) {
            const constraints = this.getOrderConstraints(symbol);
            const decimals = Math.max(0, Math.ceil(-Math.log10(constraints.tickSize)));
            return parseFloat(price.toFixed(decimals)).toString();
        }
        return parseFloat(price.toFixed(2)).toString();
    }

    formatPriceSync(price, constraints) {
        try {
            if (constraints && constraints.tickSize) {
                const decimals = Math.max(0, Math.ceil(-Math.log10(constraints.tickSize)));
                return parseFloat(price.toFixed(decimals)).toString();
            }
            return parseFloat(price.toFixed(6)).toString(); // Fallback to 6 decimals
        } catch (error) {
            logIT(`Error formatting price: ${error.message}, using fallback`, LOG_LEVEL.WARNING);
            return parseFloat(price.toFixed(6)).toString();
        }
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default ScaledATRDCA;