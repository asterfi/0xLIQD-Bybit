/**
 * Data Persistence Manager for Scaled ATR DCA System
 * Handles persistent storage for DCA positions, ATR cache, and configuration
 */

import fs from 'fs';
import { logIT, LOG_LEVEL } from './log.js';

class DataPersistence {
    constructor() {
        this.dataDir = './data';
        this.ensureDataDirectory();
    }

    /**
     * Ensure data directory exists
     */
    ensureDataDirectory() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
            logIT('Created data directory for persistence', LOG_LEVEL.INFO);
        }
    }

    /**
     * Save DCA position state to persistent storage
     */
    saveDCAPositions(positions) {
        try {
            const filePath = `${this.dataDir}/dca_positions.json`;
            const data = {
                timestamp: Date.now(),
                version: '1.0',
                positions: Array.from(positions.entries()).map(([id, state]) => ({
                    id,
                    ...state,
                    // Convert Maps to Arrays for JSON serialization
                    levels: state.levels,
                    executedLevels: state.executedLevels,
                    activeOrders: state.activeOrders
                }))
            };

            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            logIT(`Saved ${positions.size} DCA positions to persistent storage`, LOG_LEVEL.INFO);
        } catch (error) {
            logIT(`Error saving DCA positions: ${error.message}`, LOG_LEVEL.ERROR);
        }
    }

    /**
     * Load DCA positions from persistent storage
     */
    loadDCAPositions() {
        try {
            const filePath = `${this.dataDir}/dca_positions.json`;
            if (!fs.existsSync(filePath)) {
                return new Map();
            }

            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const positions = new Map();

            data.positions.forEach(pos => {
                // Restore position state
                const state = {
                    ...pos,
                    levels: pos.levels || [],
                    executedLevels: pos.executedLevels || [],
                    activeOrders: pos.activeOrders || []
                };
                positions.set(pos.id, state);
            });

            logIT(`Loaded ${positions.size} DCA positions from persistent storage`, LOG_LEVEL.INFO);
            return positions;
        } catch (error) {
            logIT(`Error loading DCA positions: ${error.message}`, LOG_LEVEL.ERROR);
            return new Map();
        }
    }

    /**
     * Save ATR cache to persistent storage
     */
    saveATRCache(cache) {
        try {
            const filePath = `${this.dataDir}/atr_cache.json`;
            const data = {
                timestamp: Date.now(),
                version: '1.0',
                cache: Array.from(cache.entries()).map(([key, value]) => ({
                    key,
                    ...value
                }))
            };

            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            logIT(`Saved ${cache.size} ATR values to persistent storage`, LOG_LEVEL.DEBUG);
        } catch (error) {
            logIT(`Error saving ATR cache: ${error.message}`, LOG_LEVEL.ERROR);
        }
    }

    /**
     * Load ATR cache from persistent storage
     */
    loadATRCache() {
        try {
            const filePath = `${this.dataDir}/atr_cache.json`;
            if (!fs.existsSync(filePath)) {
                return new Map();
            }

            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const cache = new Map();

            // Filter out expired entries (older than 5 minutes)
            const now = Date.now();
            const cacheTimeout = 5 * 60 * 1000;

            data.cache.forEach(entry => {
                if (now - entry.timestamp < cacheTimeout) {
                    cache.set(entry.key, {
                        value: entry.value,
                        timestamp: entry.timestamp
                    });
                }
            });

            logIT(`Loaded ${cache.size} valid ATR values from persistent storage`, LOG_LEVEL.DEBUG);
            return cache;
        } catch (error) {
            logIT(`Error loading ATR cache: ${error.message}`, LOG_LEVEL.ERROR);
            return new Map();
        }
    }

    /**
     * Save DCA configuration
     */
    saveDCAConfig(config) {
        try {
            const filePath = `${this.dataDir}/dca_config.json`;
            const data = {
                timestamp: Date.now(),
                version: '1.0',
                config: config
            };

            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            logIT('Saved DCA configuration to persistent storage', LOG_LEVEL.INFO);
        } catch (error) {
            logIT(`Error saving DCA config: ${error.message}`, LOG_LEVEL.ERROR);
        }
    }

    /**
     * Load DCA configuration
     */
    loadDCAConfig() {
        try {
            const filePath = `${this.dataDir}/dca_config.json`;
            if (!fs.existsSync(filePath)) {
                return null;
            }

            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            logIT('Loaded DCA configuration from persistent storage', LOG_LEVEL.INFO);
            return data.config;
        } catch (error) {
            logIT(`Error loading DCA config: ${error.message}`, LOG_LEVEL.ERROR);
            return null;
        }
    }

    /**
     * Save performance statistics
     */
    savePerformanceStats(stats) {
        try {
            const filePath = `${this.dataDir}/performance_stats.json`;
            const data = {
                timestamp: Date.now(),
                version: '1.0',
                stats: stats
            };

            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            logIT('Saved performance statistics to persistent storage', LOG_LEVEL.DEBUG);
        } catch (error) {
            logIT(`Error saving performance stats: ${error.message}`, LOG_LEVEL.ERROR);
        }
    }

    /**
     * Load performance statistics
     */
    loadPerformanceStats() {
        try {
            const filePath = `${this.dataDir}/performance_stats.json`;
            if (!fs.existsSync(filePath)) {
                return null;
            }

            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return data.stats;
        } catch (error) {
            logIT(`Error loading performance stats: ${error.message}`, LOG_LEVEL.ERROR);
            return null;
        }
    }

    /**
     * Clean up old data files
     */
    cleanupOldData(maxAgeDays = 7) {
        try {
            const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
            const now = Date.now();

            const files = [
                'dca_positions.json',
                'atr_cache.json',
                'performance_stats.json'
            ];

            files.forEach(file => {
                const filePath = `${this.dataDir}/${file}`;
                if (fs.existsSync(filePath)) {
                    const stats = fs.statSync(filePath);
                    if (now - stats.mtime.getTime() > maxAge) {
                        fs.unlinkSync(filePath);
                        logIT(`Cleaned up old data file: ${file}`, LOG_LEVEL.INFO);
                    }
                }
            });

            logIT('Data cleanup completed', LOG_LEVEL.INFO);
        } catch (error) {
            logIT(`Error during data cleanup: ${error.message}`, LOG_LEVEL.ERROR);
        }
    }

    /**
     * Get data directory statistics
     */
    getDataStats() {
        try {
            const stats = {
                dataDir: this.dataDir,
                files: [],
                totalSize: 0
            };

            const files = [
                'dca_positions.json',
                'atr_cache.json',
                'dca_config.json',
                'performance_stats.json'
            ];

            files.forEach(file => {
                const filePath = `${this.dataDir}/${file}`;
                if (fs.existsSync(filePath)) {
                    const fileStats = fs.statSync(filePath);
                    stats.files.push({
                        name: file,
                        size: fileStats.size,
                        lastModified: fileStats.mtime
                    });
                    stats.totalSize += fileStats.size;
                }
            });

            return stats;
        } catch (error) {
            logIT(`Error getting data stats: ${error.message}`, LOG_LEVEL.ERROR);
            return null;
        }
    }
}

export default DataPersistence;