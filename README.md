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

#### Trading & Position Management
```
LEVERAGE = 20                           # Default leverage for trades (1-100)
MAX_OPEN_POSITIONS = 2                  # Maximum concurrent positions
MAX_POSITION_SIZE_PERCENT = 33           # Max position size as % of total equity
PERCENT_ORDER_SIZE = 10                  # Order size as % of equity (0.01 = 1%)
MIN_LIQUIDATION_VOLUME = 1500           # Minimum liquidation volume in USDT to trigger trades
USE_DCA_FEATURE = true                  # Enable DCA (Dollar Cost Averaging) for existing positions
RISK_LEVEL = 2                          # Risk level for smart settings (1=conservative, 5=aggressive, 0=disable)
UPDATE_MIN_ORDER_SIZING = true           # Auto-update min order sizes based on balance
USE_SET_LEVERAGE = true                  # Automatically set leverage on all pairs
MARGIN = CROSS                          # Margin mode (CROSS/ISOLATED) - currently not implemented
```

#### Take Profit & Stop Loss
```
USE_TAKE_PROFIT = true                  # Enable take profit functionality
TAKE_PROFIT_PERCENT = 0.484             # Take profit percentage (0.484 = 0.484%)
USE_STOPLOSS = true                     # Enable stop loss functionality
STOP_LOSS_PERCENT = 50                  # Stop loss percentage (50 = 50%)
```

#### Smart Settings & Market Data
```
USE_SMART_SETTINGS = true                # Use AI-powered smart settings from liquidation.report
```

#### Risk Management & Filters
```
BLACKLIST = ETHUSDT, BTCUSDT, C98USDT    # Pairs to exclude from trading
USE_WHITELIST = false                    # If true, only trade pairs in WHITELIST
WHITELIST = ETCUSDT, BCHUSDT, LINKUSDT   # Whitelist pairs (only active when USE_WHITELIST=true)
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
