import { env } from 'process';
import moment from 'moment';
import fs from 'fs';
import path from 'path';

export const LOG_LEVEL = {
  UNDEFINED : -1,
  DEBUG : 0,
  INFO  : 1,
  WARNING : 2,
  ERROR : 3,
};

const logLevelStr = ["DEBUG", "INFO", "WARNING", "ERROR"];

// Log management configuration
const CONFIG_LOG_SIZE = parseInt(process.env.LOG_MAX_FILE_SIZE) || 10; // Default 10MB per log file
const MAX_LOG_SIZE = CONFIG_LOG_SIZE * 1024 * 1024; 
const MAX_LOG_FILES = parseInt(process.env.LOG_MAX_FILES) || 5; // Keep last 5 log files
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS) || 7;
const LOG_ROTATION_ENABLED = process.env.LOG_ROTATION_ENABLED !== 'false';
const LOG_DIR = 'logs';

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Get current log filename with date
function getCurrentLogFilename() {
  const date = moment().format('YYYY-MM-DD');
  return path.join(LOG_DIR, `bot-${date}.log`);
}

// Rotate log files if they exceed size limit
function rotateLogFiles() {
  try {
    const logFiles = fs.readdirSync(LOG_DIR)
      .filter(file => file.startsWith('bot-') && file.endsWith('.log'))
      .map(file => ({
        name: file,
        path: path.join(LOG_DIR, file),
        stats: fs.statSync(path.join(LOG_DIR, file))
      }))
      .sort((a, b) => b.stats.mtime - a.stats.mtime);

    // Remove old files if we exceed max count
    while (logFiles.length > MAX_LOG_FILES) {
      const oldFile = logFiles.pop();
      fs.unlinkSync(oldFile.path);
      console.log(`Removed old log file: ${oldFile.name}`);
    }
  } catch (error) {
    console.error('Error rotating log files:', error);
  }
}

// Check if log file needs rotation
function checkLogRotation() {
  if (!LOG_ROTATION_ENABLED) return;

  const currentLogFile = getCurrentLogFilename();

  if (fs.existsSync(currentLogFile)) {
    const stats = fs.statSync(currentLogFile);
    if (stats.size >= MAX_LOG_SIZE) {
      // Archive current log and create new one
      const archiveName = path.join(LOG_DIR, `bot-${moment().format('YYYY-MM-DD_HH-mm-ss')}.log`);
      fs.renameSync(currentLogFile, archiveName);
      console.log(`Rotated log file: ${currentLogFile} -> ${archiveName}`);
      rotateLogFiles();
    }
  }
}

// Clean up old logs (additional safety measure)
function cleanupOldLogs() {
  if (!LOG_ROTATION_ENABLED) return;

  try {
    const cutoffDate = moment().subtract(LOG_RETENTION_DAYS, 'days').toDate();
    const logFiles = fs.readdirSync(LOG_DIR);

    logFiles.forEach(file => {
      if (file.startsWith('bot-') && file.endsWith('.log')) {
        const filePath = path.join(LOG_DIR, file);
        const stats = fs.statSync(filePath);

        if (stats.mtime < cutoffDate) {
          fs.unlinkSync(filePath);
          console.log(`Cleaned up old log file: ${file}`);
        }
      }
    });
  } catch (error) {
    console.error('Error cleaning up old logs:', error);
  }
}

// Export enhanced logging function
export function logIT(msg, level = LOG_LEVEL.INFO) {
  // Check log level filter
  const logLevel = logLevelStr.findIndex(el => el == process.env.LOG_LEVEL);
  if (logLevel === -1) {
    console.log('[' + moment().local().toString() + '] :: ' + "ERROR BAD LOG LEVEL");
    return;
  }

  if (level < logLevel)
    return;

  // Clean message of ANSI color codes
  const cleanMsg = msg.replace(/\u001b\[\d+m/g, '');

  // Format timestamp
  const timestamp = moment().local().toString();

  // Console output
  console.log(`[${timestamp}] :: ${msg}`);

  // File logging
  if (process.env.USE_LOG === "true") {
    checkLogRotation();
    const currentLogFile = getCurrentLogFilename();

    try {
      fs.appendFile(currentLogFile, `[${timestamp}] ${cleanMsg}\n`, function (err) {
        if (err) {
          console.error("Logging error:", err);
        }
      });
    } catch (error) {
      console.error("Failed to write to log file:", error);
    }
  }
}

// Export utility functions for manual cleanup
export function cleanupOldLogFiles() {
  cleanupOldLogs();
}

// Export function to get current log file size
export function getCurrentLogSize() {
  const currentLogFile = getCurrentLogFilename();
  if (fs.existsSync(currentLogFile)) {
    const stats = fs.statSync(currentLogFile);
    return stats.size;
  }
  return 0;
}
