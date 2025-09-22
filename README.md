# 0xLIQD-BYBIT - Bybit Liquidation Trading Bot

**Note:** This project is a fork of [CryptoGnome/Bybit-Lick-Hunter-v4](https://github.com/CryptoGnome/Bybit-Lick-Hunter-v4) with enhanced features, improved code structure, and Bybit V5 API compliance.

A sophisticated Bybit V5 API liquidation trading bot that detects market liquidations and automatically places trades with intelligent DCA, TP/SL management, and Discord notifications. This is a complete rewrite with enhanced features and 100% Bybit V5 API compliance.


---

<img width="498" height="212" alt="0xliqd" src="https://github.com/user-attachments/assets/981f4016-3ede-4d72-94db-70f2c05ab0df" />

*First off if you enjoy using open source software please use my refferel link to create a new account when using this bot, its free and helps me make more cool stuff for you guys:*

https://www.bybit.com/invite?ref=M2L8WGL

### Suggested VPS: Vultr
*Using a VPS can ensure high uptime and is much more stable than running on your own PC*

[VULTR IS OUR RECOMMENDED VPS PROVIDER](https://www.vultr.com/?ref=9806795)

### Quick Setup Steps:
*Run each of these one at a time in the terminal, and wait for each to complete.*

```
apt install npm
```

```
npm install n -g
```

```
n stable
```

```
apt install git
```

```
git clone https://github.com/asterfi/0xLIQD-Bybit.git
```

```
cd 0xliqd-bybit
```

```
npm install
```

```
cp example.env .env
```


*Edit .env to the setup you wish to run you can learn more about the settings in the next section below.*

```
sudo npm install pm2 -g 
```

```
pm2 start app.js
```

```
pm2 monit 
```

*Using pm2 will allow the bot to catch restarts and run after you close the server, if you are familiar with Linux and would prefer to use screen you could also do that.*

### Configuration Settings

The bot uses a `.env` file for configuration. Copy `example.env` to `.env` and customize the settings:

#### API Credentials & Source
```
API_KEY = apikeyhere                     # Bybit API Key (required)
API_SECRET = apisecrethere               # Bybit API Secret (required)
RAPIDAPI_KEY = rapidapi_key_here         # RapidAPI Key for liquidation data (required)
```

> **Note:** The RapidAPI key requires a **Pro subscription** to liquidation-report API. You can purchase and obtain your API key from: https://rapidapi.com/AtsutaneDotNet/api/liquidation-report

#### Trading & Position Management
```
LEVERAGE = 20                           # Default leverage for trades (1-100)
MAX_OPEN_POSITIONS = 2                  # Maximum concurrent positions
MAX_POSITION_SIZE_PERCENT = 50           # Max position size as % of total equity
PERCENT_ORDER_SIZE = 5                   # Order size as % of equity (0.05 = 5%)
MIN_LIQUIDATION_VOLUME = 1500           # Minimum liquidation volume in USDT to trigger trades
USE_DCA_FEATURE = true                  # Enable DCA (Dollar Cost Averaging) for existing positions
RISK_LEVEL = 0                          # Risk level for smart settings (0=disabled, 1=conservative, 5=aggressive)
UPDATE_MIN_ORDER_SIZING = true           # Auto-update min order sizes based on balance
USE_SET_LEVERAGE = true                  # Automatically set leverage on all pairs
USE_MAX_LEVERAGE = true                 # Use maximum available leverage for pairs (true/false)
MARGIN = REGULAR_MARGIN                 # Margin mode: ISOLATED_MARGIN, REGULAR_MARGIN, PORTFOLIO_MARGIN
HEDGE_MODE = true                       # Enable hedge position mode (true/false) for safer trading with opposite positions
```

##### Margin Mode Feature

The bot supports three margin modes through Bybit V5 API:

**Available Options:**
- **`REGULAR_MARGIN`** (default): Cross-margin where all positions share the same margin pool
- **`ISOLATED_MARGIN`**: Each position has its own isolated margin, limiting losses to that position only
- **`PORTFOLIO_MARGIN`**: Advanced portfolio margin for professional traders (higher tier accounts required)

**How it works:**
- Margin mode is automatically set on the first bot startup
- The configuration is saved to `account.json` and only set once
- Position mode (hedge vs one-way) and margin mode are set together during initial setup
- Changing the `MARGIN` variable in .env requires deleting `account.json` to reconfigure

**Benefits of Different Margin Modes:**
- **Regular Margin**: Maximum efficiency and buying power across all positions
- **Isolated Margin**: Safer approach where losses in one position don't affect others
- **Portfolio Margin**: Advanced risk management for large portfolios with offsetting positions

##### Hedge Mode Feature

When `HEDGE_MODE = true`, the bot can open opposite positions (long/short) on the same trading pair. This provides enhanced safety when market movements go against existing positions while still allowing profits from market volatility.

**Benefits of Hedge Mode:**
- **Safety Net**: If one position moves against you, the opposite position can offset losses
- **Market Neutral**: Profit from both upward and downward market movements
- **Enhanced Risk Management**: Better control over exposure during volatile markets

**How it works:**
- When `HEDGE_MODE = false` (default): Traditional one-way trading - only one position per pair
- When `HEDGE_MODE = true`: Hedge trading - allows both long and short positions on the same pair
- The bot will automatically set Bybit account to hedge mode (positionMode = 3)
- TP/SL management works independently for each position side

#### Take Profit & Stop Loss
```
USE_TAKE_PROFIT = true                  # Enable take profit functionality
TAKE_PROFIT_PERCENT = 0.484             # Take profit percentage (0.484 = 0.484%)
USE_STOPLOSS = false                    # Enable stop loss functionality
STOP_LOSS_PERCENT = 50                  # Stop loss percentage (50 = 50%)
```

#### Smart Settings & Market Data
```
USE_SMART_SETTINGS = true                # Use AI-powered smart settings from liquidation.report
```

#### Risk Management & Filters
```
BLACKLIST = ETHUSDT, BTCUSDT, BNBUSDT    # Pairs to exclude from trading
USE_WHITELIST = false                    # If true, only trade pairs in WHITELIST
WHITELIST =                             # Whitelist pairs (only active when USE_WHITELIST=true)
MIN_24H_VOLUME = 50                      # Minimum 24h trading volume in millions (e.g., 50 = $50M). Set to 0 to disable
```

#### Discord Integration
```
USE_DISCORD = true                      # Enable Discord webhook notifications
DISCORD_URL = webhook_url_here          # Discord webhook URL for trade alerts
DISCORD_REPORT_INTERVAL = 30            # Report interval in minutes (30 default)
```

#### Logging & Monitoring
```
USE_LOG = true                          # Enable file logging
LOG_LEVEL = INFO                        # Log level (DEBUG, INFO, WARNING, ERROR)
LOG_MAX_FILE_SIZE = 10                  # Max log file size in MB
LOG_MAX_FILES = 5                        # Number of log files to retain
LOG_RETENTION_DAYS = 7                  # Number of days to keep log files
LOG_ROTATION_ENABLED = true              # Enable automatic log rotation
```

*Webhook Examples*

<img width="405" height="183" alt="image" src="https://github.com/user-attachments/assets/6b8275ad-20a5-493d-9c2f-823bd80203ba" />

<img width="606" height="534" alt="image" src="https://github.com/user-attachments/assets/80f67349-5225-418e-8172-9cf16376bd2d" />

### TO START AND STOP BOT

```
pm2 list to get id
```

```
pm2 stop id
```

```
pm2 start id
```

### TO UPDATE BOT WHEN A NEW RELEASE IS OUT

```
cd 0xliqd-bybit
```

```
git stash
```

```
git pull
```

### Check For Errors 

```
pm2 logs 'App ID' --err --lines 1000
```

### Recent Updates and Enhancements

#### 🚀 Scaled ATR DCA System
The bot now features an advanced **Scaled ATR DCA** system that uses Average True Range calculations to create intelligent DCA orders with proper scaling:

**Key Features:**
- **Fast ATR Calculation**: Uses 5m timeframe with 7 periods for responsive volatility measurement (optimized for low hold time trading)
- **Scaled Orders**: Each subsequent DCA order has increased volume and wider price deviation
- **Price Precision**: Automatic formatting based on exchange constraints
- **Position Locking**: Prevents duplicate positions for the same symbol and side

**ATR Configuration:**
```
USE_SCALED_ATR_DCA = true               # Enable Scaled ATR DCA system
ATR_TIMEFRAME = 5m                      # Timeframe for ATR calculation (1m, 5m, 15m, 1h, 4h, 1d)
ATR_LENGTH = 7                          # Number of candles for ATR calculation
ATR_DEVIATION = 0.5                     # ATR multiplier for first DCA order (0.5 = 0.5x ATR)
DCA_NUM_ORDERS = 7                      # Total number of DCA orders per trade
DCA_VOLUME_SCALE = 1.5                  # Volume scale multiplier for each subsequent order
DCA_STEP_SCALE = 1.2                    # Price deviation multiplier for each subsequent order
```

#### 🛡️ Enhanced Position Management
- **Duplicate Position Prevention**: Enhanced validation prevents creating multiple positions for the same symbol and side
- **Position Size Validation**: Orders are validated against maximum position size limits
- **DCA Cleanup**: Automatic cleanup of DCA positions when main positions hit TP/SL
- **Cache Management**: Optional cache reset on bot startup for fresh trading sessions

#### 📊 Cache Management
```
RESET_CACHE_ON_STARTUP = true           # Reset all cache files on bot startup (recommended for fresh starts)
```

**Cache Files:**
- `data/atr_cache.json`: ATR calculation cache for performance optimization
- `data/dca_positions.json`: Active DCA position tracking
- `data/performance_stats.json`: Trading performance statistics

#### 🔄 Recent Bug Fixes
- **Discord Notifications**: Fixed "amount.toFixed is not a function" error in webhook messages
- **Price Precision**: Resolved async/sync mismatch in price formatting causing exchange errors
- **TP/SL Validation**: Enhanced validation logic for take profit and stop loss price logic
- **DCA Order Cancellation**: Fixed symbol parameter errors in order cancellation
- **Position Calculation**: Fixed DCA calculation consistency between USDT values and coin quantities

#### 🎯 Trading Strategy Improvements
- **Smart Volume Filtering**: Only trades pairs with sufficient 24h volume (configurable)
- **Real-time Order Monitoring**: Automatic detection of position closures and cleanup
- **Enhanced Error Handling**: Graceful degradation when external APIs are unavailable
- **Performance Optimization**: Cache hit rate monitoring and memory usage tracking

#### 🔧 API Data Service Update Intervals
```
RESEARCH_UPDATE_INTERVAL = 5            # Update research.json every 5 minutes
MIN_ORDER_SIZE_UPDATE_INTERVAL = 5      # Update min_order_sizes.json every 5 minutes
SETTINGS_UPDATE_INTERVAL = 5             # Update settings.json every 5 minutes
ACCOUNT_UPDATE_INTERVAL = 1              # Update account.json every 1 minute
```
