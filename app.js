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
import { createPositionFromOrder } from './position.js';
import { calculateRiskPrices, processOrderQuantity, shouldProcessPair, calculateBotUptime } from './utils.js';

// used to calculate bot runtime
const timestampBotStart = moment();

var discordService;
if (process.env.USE_DISCORD == "true") {
    discordService = new DiscordService(process.env.DISCORD_URL);
}

const key = process.env.API_KEY;
const secret = process.env.API_SECRET;
var rateLimit = 2000;
var lastReport = 0;
var pairs = [];
var liquidationOrders = [];
var lastUpdate = 0;

//create ws client
const wsClient = new WebsocketClient({
    key: key,
    secret: secret
});

//create REST client
const restClient = new RestClientV5({
    key: key,
    secret: secret,
    testnet: false,
    recv_window: 5000
});

// Initialize logging system - clean up old logs at startup
logIT("Starting 0xLIQD-BYBIT bot", LOG_LEVEL.INFO);
logIT("Initializing log management system", LOG_LEVEL.DEBUG);
cleanupOldLogFiles();

wsClient.on('update', (data) => {
    logIT('WebSocket update received', LOG_LEVEL.DEBUG);
    const liquidationData = data.data || data;

    liquidationData.forEach(liqData => {
        var pair = liqData.s;
        var price = parseFloat(liqData.p);
        var side = liqData.S;

        //convert to float
        var qty = parseFloat(liqData.v) * price;

        //create timestamp
        var timestamp = Math.floor(Date.now() / 1000);

        //find what index of liquidationOrders array is the pair
        var index = liquidationOrders.findIndex(x => x.pair === pair);

        var dir = "";
        if (side === "Buy") {
            dir = "Long";
        } else {
            dir = "Short";
        }

        // Check if pair should be processed using blacklist/whitelist utilities
        if (!shouldProcessPair(pair, process.env.BLACKLIST, process.env.WHITELIST)) {
            console.log(chalk.gray("Liquidation Found for Blacklisted pair: " + pair + " ignoring..."));
            return;
        }

        //if pair is not in liquidationOrders array, add it
        if (index === -1) {
            liquidationOrders.push({pair: pair, price: price, side: side, qty: qty, amount: 1, timestamp: timestamp});
            index = liquidationOrders.findIndex(x => x.pair === pair);
        }

        //if pair is in liquidationOrders array, update it
        if (index !== -1) {
            //check if timestamp is within 5 seconds of previous timestamp
            if (timestamp - liquidationOrders[index].timestamp <= 5) {
                liquidationOrders[index].price = price;
                liquidationOrders[index].side = side;
                //add qty to existing qty and round to 2 decimal places
                liquidationOrders[index].qty = parseFloat((liquidationOrders[index].qty + qty).toFixed(2));
                liquidationOrders[index].timestamp = timestamp;
                liquidationOrders[index].amount = liquidationOrders[index].amount + 1;
            } else {
                //if timestamp is more than 5 seconds from previous timestamp, overwrite
                liquidationOrders[index].price = price;
                liquidationOrders[index].side = side;
                liquidationOrders[index].qty = qty;
                liquidationOrders[index].timestamp = timestamp;
                liquidationOrders[index].amount = 1;
            }

            // Get dynamic liq_volume from research.json for this pair
            const researchData = readResearchFile();
            let dynamicLiqVolume = process.env.MIN_LIQUIDATION_VOLUME;
            if (researchData && researchData.data) {
                const symbolName = pair.replace('USDT', ''); // Remove USDT to match research.json format
                const researchEntry = researchData.data.find(item => item.name === symbolName);
                if (researchEntry && researchEntry.liq_volume) {
                    dynamicLiqVolume = researchEntry.liq_volume;
                }
            }

            if (liquidationOrders[index].qty > dynamicLiqVolume) {
                scalp(pair, index, liquidationOrders[index].qty, dynamicLiqVolume);
            } else {
                console.log(chalk.magenta("[" + liquidationOrders[index].amount + "] " + dir + " Liquidation order for " + liquidationOrders[index].pair + " with a cumulative value of " + liquidationOrders[index].qty + " USDT"));
                console.log(chalk.yellow("Not enough liquidations to trade " + liquidationOrders[index].pair));
            }
        }
    });
});

wsClient.on('open', (data) => {
    logIT(`WebSocket connection opened: ${data.wsKey}`, LOG_LEVEL.INFO);
});

wsClient.on('response', (data) => {
    logIT(`WebSocket response: ${data.wsKey}`, LOG_LEVEL.DEBUG);
});

wsClient.on('reconnect', ({ wsKey }) => {
    logIT(`WebSocket automatically reconnecting: ${wsKey}`, LOG_LEVEL.WARNING);
});

wsClient.on('reconnected', (data) => {
    logIT(`WebSocket reconnected: ${data?.wsKey}`, LOG_LEVEL.INFO);
});

//run websocket
async function liquidationEngine(pairs) {
    wsClient.subscribeV5(pairs, 'linear');
}

async function transferFunds(amount) {
    if (!amount || amount <= 0) {
        logIT(`Invalid transfer amount: ${amount}`, LOG_LEVEL.WARNING);
        return false;
    }

    try {
        const transfer = await restClient.createInternalTransfer({
            transferId: await generateTransferId(),
            coin: 'USDT',
            amount: amount.toFixed(2),
            fromAccountType: 'CONTRACT',
            toAccountType: 'SPOT',
        });

        if (transfer.retCode === 0) {
            logIT(`Successfully transferred ${amount.toFixed(2)} USDT from CONTRACT to SPOT`, LOG_LEVEL.INFO);
            if (process.env.USE_DISCORD == "true") {
                discordService.sendMessage(`Transferred ${amount.toFixed(2)} USDT to SPOT wallet`, 'success');
            }
            return true;
        } else {
            logIT(`Transfer failed: ${transfer.retMsg} (Error Code: ${transfer.retCode})`, LOG_LEVEL.ERROR);
            return false;
        }
    } catch (error) {
        logIT(`Error during transfer: ${error.message}`, LOG_LEVEL.ERROR);
        return false;
    }
}

// WITHDRAWAL FUNCTION DECOMMISSIONED - No longer needed
// Old withdrawal functionality has been removed as it's not required for the trading bot

//Generate transferId
async function generateTransferId() {
    const hexDigits = "0123456789abcdefghijklmnopqrstuvwxyz";
    let transferId = "";
    for (let i = 0; i < 32; i++) {
      transferId += hexDigits.charAt(Math.floor(Math.random() * 16));
      if (i === 7 || i === 11 || i === 15 || i === 19) {
        transferId += "-";
      }
    }
    return transferId;
}

//Get server time
async function getServerTime() {
    const data = await restClient.getServerTime();
    var usedBalance = new Date(data.time *1000);
    var balance = usedBalance.toGMTString()+'\n'+usedBalance.toLocaleString();

    //check when last was more than configured interval
    const reportInterval = getReportInterval();
    if (Date.now() - lastReport > reportInterval) {
        //send report
        reportWebhook();
        //checkCommit();
        lastReport = Date.now();
    }
    return balance;

}

function getReportInterval() {
    const CONFIG_INTERVAL = process.env.DISCORD_REPORT_INTERVAL || 30; // 30minutes default
    return CONFIG_INTERVAL * 60 * 1000;
}

//Get margin
async function getMargin() {
    const data = await restClient.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
    var usedBalance = data.result.list[0].coin[0].totalPositionIM;
    var balance = usedBalance;

    //check when last was more than configured interval
    const reportInterval = getReportInterval();
    if (Date.now() - lastReport > reportInterval) {
        //send report
        reportWebhook();
        //checkCommit();
        lastReport = Date.now();
    }
    return balance;

}

//get account balance
async function getBalance() {
    try{
        const data = await restClient.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
        const spotBal = await restClient.getWalletBalance({ accountType: 'SPOT', coin: 'USDT' });

        var availableBalance = data.result.list[0].totalAvailableBalance;
        var balance = parseFloat(availableBalance);

        //load settings.json
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

        var diff = balance - startingBalance;
        var percentGain = (diff / startingBalance) * 100;

        //check for gain to safe amount to spot
        if (diff >= settings.BalanceToSpot && settings.BalanceToSpot > 0 && process.env.TRANSFER_TO_SPOT == "false"){
            transferFunds(diff)
            console.log("Moved " + diff + " to SPOT")
        }

        // Transfer functionality for moving funds to SPOT is handled by transferFunds() when profit thresholds are reached

        //if positive diff then log green
        // if (diff >= 0) {
        //     console.log(chalk.greenBright.bold("Profit: " + diff.toFixed(4) + " USDT" + " (" + percentGain.toFixed(2) + "%)") + " | " + chalk.magentaBright.bold("Balance: " + balance.toFixed(4) + " USDT"));
        // }
        // else {
        //     console.log(chalk.redBright.bold("Profit: " + diff.toFixed(4) + " USDT" + " (" + percentGain.toFixed(2) + "%)") + "  " + chalk.magentaBright.bold("Balance: " + balance.toFixed(4) + " USDT"));

        // }

        //check when last was more than configured interval
        const reportInterval = getReportInterval();
        if (Date.now() - lastReport > reportInterval) {
            //send report
            reportWebhook();
            //checkCommit();
            lastReport = Date.now();
        }
        return balance;
    }
    catch (e) {
        return null;
    }

}
//get position
async function getPosition(pair, side) {
    try {
        //get positions for specific pair
        var positions = await restClient.getPositionInfo({ category: 'linear', symbol: pair });

        if (positions.result !== null && positions.result.list && positions.result.list.length > 0) {
            //look for pair in positions with the same side
            var index = positions.result.list.findIndex(x => x.side === side);
            if (index !== -1) {
                const size = parseFloat(positions.result.list[index].size);
                if (size >= 0) {
                    if(size > 0){
                        console.log(chalk.blueBright("Open position found for " + positions.result.list[index].symbol + " with a size of " + size + " contracts" + " with profit of " + positions.result.list[index].realisedPnl + " USDT"));
                        var profit = positions.result.list[index].unrealisedPnl;
                        //calculate the profit % change in USD
                        var leverage = parseFloat(process.env.LEVERAGE) || 1; // Default to 1 if leverage is not set or 0
                        var margin = positions.result.list[index].positionValue/leverage;
                        var percentGain = (profit / margin) * 100;
                        return {side: positions.result.list[index].side, entryPrice: positions.result.list[index].avgPrice, size: size, percentGain: percentGain};
                    }
                    else{
                        //no open position
                        return {side: positions.result.list[index].side, entryPrice: positions.result.list[index].avgPrice, size: size, percentGain: 0};
                    }
                }
                else {
                    // adding this for debugging purposes
                    console.log("Error: getPosition invalid for " + pair + " size parameter is returning " + size);
                    messageWebhook("Error: getPosition invalid for " + pair + " size parameter is returning " + size);
                    return {side: null, entryPrice: null, size: null, percentGain: null};
                }
            }
            else {
                // No position found with the specified side, check if there's any position at all for this pair
                console.log(chalk.yellow("No " + side + " position found for " + pair + ", checking for any position"));
                
                // Check if there's a position with the opposite side
                var oppositeSide = side === "Buy" ? "Sell" : "Buy";
                var oppositeIndex = positions.result.list.findIndex(x => x.side === oppositeSide);
                
                if (oppositeIndex !== -1) {
                    console.log(chalk.yellow("Found opposite side position for " + pair + ": " + oppositeSide));
                    // Return a position with size 0 to indicate no position on the requested side
                    return {side: side, entryPrice: null, size: 0, percentGain: 0};
                }
                else {
                    // No position at all for this pair
                    console.log(chalk.yellow("No position found for " + pair));
                    return {side: side, entryPrice: null, size: 0, percentGain: 0};
                }
            }
        }
        else {
            console.log(chalk.yellow("No positions data returned for " + pair));
            return {side: side, entryPrice: null, size: 0, percentGain: 0};
        }
    }
    catch (error) {
        console.log(chalk.red("Error in getPosition for " + pair + ": " + error.message));
        return {side: side, entryPrice: null, size: 0, percentGain: 0};
    }
}
//take profit
async function takeProfit(symbol, position) {

    //get entry price
    var positions = await position;

    // Debug log to see the actual position structure
    logIT(`Position data for ${symbol}: ${JSON.stringify(positions, null, 2)}`, LOG_LEVEL.DEBUG);

    // Check if positions has avgPrice (direct from API) or entryPrice (from getPosition function)
    var entryPrice = positions.avgPrice || positions.entry_price;

    // Validate position data
    if (!positions || !entryPrice || isNaN(entryPrice) || entryPrice <= 0) {
        logIT(`Invalid position data for ${symbol}. Entry price: ${entryPrice}, Full position: ${JSON.stringify(positions, null, 2)}`, LOG_LEVEL.ERROR);
        return;
    }

    // Ensure entryPrice is properly converted to number
    entryPrice = parseFloat(entryPrice);
    if (isNaN(entryPrice) || entryPrice <= 0) {
        logIT(`Invalid entry price conversion for ${symbol}. Entry price: ${entryPrice}`, LOG_LEVEL.ERROR);
        return;
    }

    // Update positions with the correct entry_price property
    positions.entry_price = entryPrice;

    // Parse and validate environment variables
    const takeProfitPercent = parseFloat(process.env.TAKE_PROFIT_PERCENT);
    
    if (isNaN(takeProfitPercent) || takeProfitPercent <= 0) {
        logIT(`Invalid take profit percentage for ${symbol}. Take profit: ${takeProfitPercent}%`, LOG_LEVEL.ERROR);
        return;
    }
    
    // Check if stop loss should be used
    const useStopLoss = process.env.USE_STOPLOSS.toLowerCase() === "true";
    var stopLoss = null;
    var stopLossPercent = null;
    
    if (useStopLoss) {
        stopLossPercent = parseFloat(process.env.STOP_LOSS_PERCENT);
        if (isNaN(stopLossPercent) || stopLossPercent <= 0) {
            logIT(`Invalid stop loss percentage for ${symbol}. Stop loss: ${stopLossPercent}%`, LOG_LEVEL.ERROR);
            return;
        }
    }
    
    if (positions.side === "Buy") {
        var side = "Buy";
        var takeProfit = positions.entry_price + (positions.entry_price * (takeProfitPercent/100));
        if (useStopLoss) {
            var stopLoss = positions.entry_price - (positions.entry_price * (stopLossPercent/100));
        }

    }
    else {
        var side = "Sell";
        var takeProfit = positions.entry_price - (positions.entry_price * (takeProfitPercent/100));
        if (useStopLoss) {
            var stopLoss = positions.entry_price + (positions.entry_price * (stopLossPercent/100));
        }
    }

    // Validate calculated prices
    if (isNaN(takeProfit) || takeProfit <= 0 || (useStopLoss && (isNaN(stopLoss) || stopLoss <= 0))) {
        console.log(chalk.red(`Invalid calculated prices for ${symbol}. Take profit: ${takeProfit}, Stop loss: ${stopLoss}`));
        return;
    }

    //load min order size json

    const tickData = JSON.parse(fs.readFileSync('min_order_sizes.json', 'utf8'));

    try {
        var index = tickData.findIndex(x => x.pair === symbol);
        if (index === -1) {
            console.log(chalk.red(`No tick data found for ${symbol}`));
            return;
        }
        var tickSize = tickData[index].tickSize;
        var decimalPlaces = (tickSize.toString().split(".")[1] || []).length;

        if (positions.size > 0 && positions.take_profit === 0 || takeProfit !== positions.take_profit) {
            if(process.env.USE_STOPLOSS.toLowerCase() === "true") {
                // Format prices as strings with correct decimal places
                const takeProfitStr = takeProfit.toFixed(decimalPlaces);
                const stopLossStr = stopLoss.toFixed(decimalPlaces);
                
                logIT(`Setting take profit for ${symbol}: ${takeProfitStr}, stop loss: ${stopLossStr}`, LOG_LEVEL.INFO);
                
                const order = await restClient.setTradingStop({
                    category: 'linear',
                    symbol: symbol,
                    takeProfit: takeProfitStr,
                    stopLoss: stopLossStr,
                });
                //console.log(JSON.stringify(order, null, 4));

                if (order.retMsg === "OK" || order.retMsg === "not modified" || order.retCode === 10002) {
                    //console.log(chalk.red("TAKE PROFIT ERROR: ", JSON.stringify(order, null, 2)));
                }
                else if (order.retCode === 130027 || order.retCode === 130030 || order.retCode === 130024) {
                    //find current price
                    var priceFetch = await restClient.getTickers({ category: 'linear', symbol: symbol });
                    var price = priceFetch.result.list[0].lastPrice;
                    //if side is sell add 1 tick to price
                    if (side === "Sell") {
                        price = parseFloat(priceFetch.result.list[0].ask1Price);
                    }
                    else {
                        price = parseFloat(priceFetch.result.list[0].bid1Price);
                    }
                    const priceStr = price.toFixed(decimalPlaces);
                    const order = await restClient.setTradingStop({
                        category: 'linear',
                        symbol: symbol,
                        takeProfit: priceStr,
                        stopLoss: stopLossStr,
                    });
                    logIT(`TAKE PROFIT FAILED FOR ${symbol} WITH ERROR PRICE MOVING TOO FAST OR ORDER ALREADY CLOSED, TRYING TO FILL AT BID/ASK!!`, LOG_LEVEL.WARNING);
                }
                else {
                    logIT(`TAKE PROFIT ERROR: ${JSON.stringify(order, null, 4)}`, LOG_LEVEL.ERROR);
                }

            }
            else {
                // Format take profit as string with correct decimal places
                const takeProfitStr = takeProfit.toFixed(decimalPlaces);
                
                logIT(`Setting take profit for ${symbol}: ${takeProfitStr}`, LOG_LEVEL.INFO);
                
                const order = await restClient.setTradingStop({
                    category: 'linear',
                    symbol: symbol,
                    takeProfit: takeProfitStr,
                });
                //console.log(JSON.stringify(order, null, 2));
                if(order.retMsg === "OK" || order.retMsg === "not modified" || order.retCode === 130024) {
                    //console.log(chalk.red("TAKE PROFIT ERROR: ", JSON.stringify(order, null, 2)));
                }
                else if (order.retCode === 130027 || order.retCode === 130030) {
                    logIT(`TAKE PROFIT FAILED PRICING MOVING FAST!! TRYING TO PLACE ABOVE CURRENT PRICE!!`, LOG_LEVEL.WARNING);
                    //find current price
                    var priceFetch = await restClient.getTickers({ category: 'linear', symbol: symbol });
                    console.log("Current price: " + JSON.stringify(priceFetch, null, 4));
                    var price = priceFetch.result.list[0].lastPrice;
                    //if side is sell add 1 tick to price
                    if (side === "Sell") {
                        price = priceFetch.result.list[0].ask1Price
                    }
                    else {
                        price = priceFetch.result.list[0].bid1Price
                    }
                    console.log("Price for symbol " + symbol + " is " + price);
                    const priceStr = price.toFixed(decimalPlaces);
                    const order = await restClient.setTradingStop({
                        category: 'linear',
                        symbol: symbol,
                        takeProfit: priceStr,
                    });
                    console.log(chalk.red("TAKE PROFIT FAILED FOR " + symbol + " WITH ERROR PRICE MOVING TOO FAST, TRYING TO FILL AT BID/ASK!!"));
                }
                else {
                    console.log(chalk.red("TAKE PROFIT ERROR: ", JSON.stringify(order, null, 2)));
                }
            }
        }
        else {
            console.log("No take profit to set for " + symbol);
        }
    }
    catch (e) {
        console.log(chalk.red("Error setting take profit: " + e + " for symbol " + symbol));
    }

}
//fetch how how openPositions there are
async function totalOpenPositions() {
    try{
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
            
            if(settingsIndex !== -1) {
                if (liquidationOrders[index].price < settings.pairs[settingsIndex].long_price)  {
                    //see if we have an open position
                    var position = await getPosition(pair, "Buy");

                    //position.size should never be null now with the improved getPosition function
                    //no open position (size === 0) - freely enter new trade
                    if (position.size === 0) {
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

                        console.log(chalk.blue("Placing Buy order for " + pair + " with quantity: " + orderQty + " (min: " + minOrderQty + ", tickSize: " + tickSize + ")"));

                        const order = await createMarketOrder(restClient, pair, "Buy", orderQty);
                        
                        // Check if order was successful
                        if (order.retCode === 0 && order.result) {
                            logIT(`New Long Order Placed for ${pair} at ${settings.pairs[settingsIndex].order_size} size`, LOG_LEVEL.INFO);
                            if(process.env.USE_DISCORD == "true") {
                                orderWebhook(pair, settings.pairs[settingsIndex].order_size, "Buy", position.size, position.percentGain, trigger_qty);
                            }
                        } else {
                            logIT(`Failed to place Long Order for ${pair}: ${order.retMsg} (Error Code: ${order.retCode})`, LOG_LEVEL.ERROR);
                            if(process.env.USE_DISCORD == "true") {
                                messageWebhook("Failed to place Long Order for " + pair + ": " + order.retMsg);
                            }
                        }
         
        
                    }
                    //existing position (size > 0) - only DCA, don't enter new trade
                    else if (position.size > 0 && process.env.USE_DCA_FEATURE == "true") {
                        //only DCA if position is at a loss
                        if (position.percentGain < 0) {
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

                                console.log(chalk.blue("Placing Buy DCA order for " + pair + " with quantity: " + orderQty + " (min: " + minOrderQty + ", tickSize: " + tickSize + ")"));
                                
                                const orderParams = {
                                    category: 'linear',
                                    symbol: pair,
                                    side: "Buy",
                                    orderType: "Market",
                                    qty: orderQty,
                                    reduceOnly: false  // Explicitly set to false to open new positions
                                };
                                
                                logIT(`DCA Order parameters: ${JSON.stringify(orderParams, null, 2)}`, LOG_LEVEL.DEBUG);
                                
                                const order = await createMarketOrder(restClient, pair, "Buy", orderQty);
                                
                                // Check if order was successful
                                if (order.retCode === 0 && order.result) {
                                    console.log(chalk.bgGreenBright("Long DCA Order Placed for " + pair + " at " + settings.pairs[settingsIndex].order_size + " size"));
                                    if(process.env.USE_DISCORD == "true") {
                                        orderWebhook(pair, settings.pairs[settingsIndex].order_size, "Buy", position.size, position.percentGain, trigger_qty);
                                    }

                                    // Update TP/SL after DCA
                                    setTimeout(async () => {
                                        try {
                                            const updatedPosition = await getPosition(pair, "Buy");
                                            if (updatedPosition.size > 0) {
                                                logIT(`Updating TP/SL after Long DCA for ${pair}`, LOG_LEVEL.INFO);
                                                await setSafeTPSL(pair, updatedPosition);
                                            }
                                        } catch (error) {
                                            logIT(`Error updating TP/SL after Long DCA for ${pair}: ${error.message}`, LOG_LEVEL.ERROR);
                                        }
                                    }, 500); // Small delay to ensure DCA order is filled
                                } else {
                                    console.log(chalk.redBright("Failed to place Long DCA Order for " + pair + ": " + order.retMsg + " (Error Code: " + order.retCode + ")"));
                                    if(process.env.USE_DISCORD == "true") {
                                        messageWebhook("Failed to place Long DCA Order for " + pair + ": " + order.retMsg);
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
                console.log(chalk.bgRedBright( pair + " does not exist in settings.json"));
            }

        }
        else {
            const settings = await JSON.parse(fs.readFileSync('settings.json', 'utf8'));
            var settingsIndex = await settings.pairs.findIndex(x => x.symbol === pair);
            if(settingsIndex !== -1) {
                if (liquidationOrders[index].price > settings.pairs[settingsIndex].short_price)  {
                    var position = await getPosition(pair, "Sell");

                    //position.size should never be null now with the improved getPosition function
                    //no open position (size === 0) - freely enter new trade
                    if (position.size === 0) {
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

                        console.log(chalk.blue("Placing Sell order for " + pair + " with quantity: " + orderQty + " (min: " + minOrderQty + ", tickSize: " + tickSize + ")"));

                        const order = await createMarketOrder(restClient, pair, "Buy", orderQty);
                        
                        // Check if order was successful
                        if (order.retCode === 0 && order.result) {
                            logIT(`New Short Order Placed for ${pair} at ${settings.pairs[settingsIndex].order_size} size`, LOG_LEVEL.INFO);
                            if(process.env.USE_DISCORD == "true") {
                                orderWebhook(pair, settings.pairs[settingsIndex].order_size, "Sell", position.size, position.percentGain, trigger_qty);
                            }
                        } else {
                            logIT(`Failed to place Short Order for ${pair}: ${order.retMsg} (Error Code: ${order.retCode})`, LOG_LEVEL.ERROR);
                            if(process.env.USE_DISCORD == "true") {
                                messageWebhook("Failed to place Short Order for " + pair + ": " + order.retMsg);
                            }
                        }
                    }
                    //existing position (size > 0) - only DCA, don't enter new trade
                    else if (position.size > 0 && process.env.USE_DCA_FEATURE == "true") {
                        //only DCA if position is at a loss
                        if (position.percentGain < 0) {
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

                                console.log(chalk.blue("Placing Sell DCA order for " + pair + " with quantity: " + orderQty + " (min: " + minOrderQty + ", tickSize: " + tickSize + ")"));
                                
                                const orderParams = {
                                    category: 'linear',
                                    symbol: pair,
                                    side: "Sell",
                                    orderType: "Market",
                                    qty: orderQty,
                                    reduceOnly: false  // Explicitly set to false to open new positions
                                };
                                
                                logIT(`DCA Order parameters: ${JSON.stringify(orderParams, null, 2)}`, LOG_LEVEL.DEBUG);
                                
                                const order = await createMarketOrder(restClient, pair, "Buy", orderQty);
                                
                                // Check if order was successful
                                if (order.retCode === 0 && order.result) {
                                    console.log(chalk.bgRedBright("Short DCA Order Placed for " + pair + " at " + settings.pairs[settingsIndex].order_size + " size"));
                                    if(process.env.USE_DISCORD == "true") {
                                        orderWebhook(pair, settings.pairs[settingsIndex].order_size, "Sell", position.size, position.percentGain, trigger_qty);
                                    }

                                    // Update TP/SL after DCA
                                    setTimeout(async () => {
                                        try {
                                            const updatedPosition = await getPosition(pair, "Sell");
                                            if (updatedPosition.size > 0) {
                                                logIT(`Updating TP/SL after Short DCA for ${pair}`, LOG_LEVEL.INFO);
                                                await setSafeTPSL(pair, updatedPosition);
                                            }
                                        } catch (error) {
                                            logIT(`Error updating TP/SL after Short DCA for ${pair}: ${error.message}`, LOG_LEVEL.ERROR);
                                        }
                                    }, 500); // Small delay to ensure DCA order is filled
                                } else {
                                    console.log(chalk.redBright("Failed to place Short DCA Order for " + pair + ": " + order.retMsg + " (Error Code: " + order.retCode + ")"));
                                    if(process.env.USE_DISCORD == "true") {
                                        messageWebhook("Failed to place Short DCA Order for " + pair + ": " + order.retMsg);
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

        const set = await restClient.setLeverage(
            {
                category: 'linear',
                symbol: pair,
                buyLeverage: leverage,
                sellLeverage: leverage,
            }
        );
        try{
            var maxLeverage = await checkLeverage(pair);
            if (maxLeverage >= parseFloat(leverage)) {
                logIT(`Leverage for ${pair} is set to ${leverage}`, LOG_LEVEL.INFO);
            }
            else {
                logIT(`Unable to set leverage for ${pair} to ${leverage}. Max leverage is lower than ${leverage}, removing pair from settings.json`, LOG_LEVEL.WARNING);
                //remove pair from settings.json
                const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
                var settingsIndex = settings.pairs.findIndex(x => x.symbol === pair);
                if(settingsIndex !== -1) {
                    settings.pairs.splice(settingsIndex, 1);
                    fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
                }
            }
            


        }
        catch (e) {
            logIT(`ERROR setting leverage for ${pair} to ${leverage}: ${e}`, LOG_LEVEL.ERROR);
            await sleep(1000);
        }

    }

}

//set position mode to hedge
async function setPositionMode() {

    const set = await restClient.switchPositionMode({
        category: 'linear',
        coin: "USDT",
        mode: 0 // One-way mode in V5
    });
    //log responses
    if (set.retCode == 0) {
        logIT("Position mode set to One-way", LOG_LEVEL.INFO);
        return true;
    }
    else {
        logIT("Unable to set position mode", LOG_LEVEL.ERROR);
        return false;
    }
    
}

async function checkLeverage(symbol) {
    var position = await restClient.getInstrumentsInfo({ category: 'linear', symbol: symbol });
    var leverage = position.result.list[0].leverageFilter.maxLeverage ?? 0;
    return parseFloat(leverage);
}
//create loop that checks for open positions every second
async function checkOpenPositions() {
    //get all positions
    var positions = await restClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT' });
    
    //console.log("Positions: " + JSON.stringify(positions, null, 2));
    var totalPositions = 0;
    var postionList = [];
    if (positions.result !== null && positions.result.list) {
        for (var i = 0; i < positions.result.list.length; i++) {
            if (positions.result.list[i].size > 0) {
                //console.log("Open Position for " + positions.result.list[i].symbol + " with size " + positions.result.list[i].size + " and side " + positions.result.list[i].side + " and pnl " + positions.result.list[i].unrealisedPnl);
               
                await setSafeTPSL(positions.result.list[i].symbol, positions.result.list[i]);
   
                // Convert API position to our position structure
                const positionObj = {
                    symbol: positions.result.list[i].symbol,
                    size: positions.result.list[i].size,
                    avgPrice: positions.result.list[i].avgPrice,
                    side: positions.result.list[i].side,
                    unrealisedPnl: positions.result.list[i].unrealisedPnl,
                    createdTime: positions.result.list[i].createdTime || Date.now()
                };

                // Calculate USD value using position utility with proper leverage
                const positionLeverage = positions.result.list[i].leverage || parseFloat(process.env.LEVERAGE);
                const structuredPosition = createPositionFromOrder(positionObj, positionLeverage);
                totalPositions++;

                //create object to store in postionList
                var position = {
                    symbol: structuredPosition.symbol,
                    size: structuredPosition.size,
                    usdValue: structuredPosition.sizeUSD,
                    side: structuredPosition.side,
                    pnl: structuredPosition.pnl
                }
                postionList.push(position);
                
            }
        }
    }
    else {
        logIT("Open positions response is null", LOG_LEVEL.WARNING);
    }
    // console.log("----------------------------------------------------");
    // console.log("------------------ OPEN POSITIONS ------------------");
    // console.log("----------------------------------------------------");
    // console.table(postionList);

}

async function getMinTradingSize() {
    const instruments = await restClient.getInstrumentsInfo({ category: 'linear' });
    // console.log(instruments.result.list);

    // const url = "https://api.bybit.com/v5/market/instruments-info?category=linear";
    // const response = await fetch(url);
    // const data = await response.json();

    var balance = await getBalance();

    if (balance !== null) {
        var tickers = await restClient.getTickers({ category: 'linear' });
        var positions = await restClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT' });

        var minOrderSizes = [];
        console.log("Fetching min Trading Sizes for pairs, this could take a minute...");
        for (var i = 0; i < instruments.result.list.length; i++) {
            console.log("Pair: " + instruments.result.list[i].symbol + " Min Trading Size: " + instruments.result.list[i].lotSizeFilter.minOrderQty);
            //check if minOrderQty usd value is less than process.env.MIN_ORDER_SIZE
            var minOrderSize = instruments.result.list[i].lotSizeFilter.minOrderQty;
            //get price of pair from tickers
            var priceFetch = tickers.result.list.find(x => x.symbol === instruments.result.list[i].symbol);
            var price = priceFetch.lastPrice;
            //get usd value of min order size
            var usdValue = (minOrderSize * price);
            //console.log("USD value of " + instruments.result.list[i].symbol + " is " + usdValue);
            //find usd valie of process.env.MIN_ORDER_SIZE
            var minOrderSizeUSD = (balance * process.env.PERCENT_ORDER_SIZE/100) * process.env.LEVERAGE;
            //console.log("USD value of " + process.env.PERCENT_ORDER_SIZE + " is " + minOrderSizeUSD);
            if (minOrderSizeUSD < usdValue) {
                //use min order size
                var minOrderSizePair = minOrderSize;
            }
            else {
                //convert min orderSizeUSD to pair value
                var minOrderSizePair = (minOrderSizeUSD / price);
            }
            try{
                //find pair in positions
                var position = positions.result.list.find(x => x.symbol === instruments.result.list[i].symbol);
                // var leverage = position.leverage;
        
                // if (position) {
                    //find max position size for pair
                    var maxPositionSize = ((balance * (process.env.MAX_POSITION_SIZE_PERCENT/100)) / price) * process.env.LEVERAGE;
                    //save min order size and max position size to json
                    var minOrderSizeJson = {
                        "pair": instruments.result.list[i].symbol,
                        "minOrderSize": minOrderSizePair,
                        "maxPositionSize": maxPositionSize,
                        "tickSize": instruments.result.list[i].priceFilter.tickSize,
                    }
                    //add to array
                    minOrderSizes.push(minOrderSizeJson);

                // }
                // else {
                //     const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
                //     var settingsIndex = settings.pairs.findIndex(x => x.symbol === instruments.result.list[i].symbol);
                //     if(settingsIndex !== -1) {
                //         settings.pairs.splice(settingsIndex, 1);
                //         fs.writeFileSync('settings.json', JSON.stringify(settings, null, 2));
                //     }
                // }
            }
            catch (e) {
                // console.log(e);
                await sleep(10);
            }

        }
        fs.writeFileSync('min_order_sizes.json', JSON.stringify(minOrderSizes, null, 4));


        //update settings.json with min order sizes
        const settings = JSON.parse(fs.readFileSync('settings.json', 'utf8'));
        for (var i = 0; i < minOrderSizes.length; i++) {
            var settingsIndex = settings.pairs.findIndex(x => x.symbol === minOrderSizes[i].pair);
            if(settingsIndex !== -1) {
                settings.pairs[settingsIndex].order_size = minOrderSizes[i].minOrderSize;
                settings.pairs[settingsIndex].max_position_size = minOrderSizes[i].maxPositionSize;
                
            }
        }
    }
    else {
        console.log("Error fetching balance");
    }

}
//get all symbols
async function getSymbols() {
    try{
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
    catch{
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
        console.log(chalk.red("Error reading research.json:", err));
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
        
        //create settings.json file with multiple pairs
        var settings = {};
        settings["pairs"] = [];
        for (var i = 0; i < out.data.length; i++) {
            //console.log("Adding Smart Settings for " + out.data[i].name + " to settings.json");
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

                    var pair = {
                        "symbol": out.data[i].name + "USDT",
                        "leverage": process.env.LEVERAGE,
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

    }).catch(err => {
        logIT(`Error fetching research data: ${err}`, LOG_LEVEL.ERROR);
        // Try to use existing research.json if available
        const researchFile = readResearchFile();
        if (researchFile && researchFile.data) {
            logIT("Using existing research.json data to create settings", LOG_LEVEL.INFO);
            var settings = {};
            settings["pairs"] = [];
            for (var i = 0; i < researchFile.data.length; i++) {
                //console.log("Adding Smart Settings for " + researchFile.data[i].name + " to settings.json");
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
                        //risk level
                        var riskLevel = process.env.RISK_LEVEL;
                        if (riskLevel == 1) {
                            //add 0.5% to long_price and subtract 0.5% from short_price
                            var long_risk = researchFile.data[i].long_price * 1.005
                            var short_risk = researchFile.data[i].short_price * 0.995
                        }
                        else if (riskLevel == 2) {
                            //calculate price 1% below current price and1% above current price
                            var long_risk = researchFile.data[i].long_price * 1.01
                            var short_risk = researchFile.data[i].short_price * 0.99
                        }
                        else if (riskLevel == 3) {
                            //calculate price 2% below current price and 2% above current price
                            var long_risk = researchFile.data[i].long_price * 1.02
                            var short_risk = researchFile.data[i].short_price * 0.98
                        }
                        else if (riskLevel == 4) {
                            //calculate price 3% below current price and 3% above current price
                            var long_risk = researchFile.data[i].long_price * 1.03
                            var short_risk = researchFile.data[i].short_price * 0.97
                        }
                        else if (riskLevel == 5) {
                            //calculate price 4% below current price and 4% above current price
                            var long_risk = researchFile.data[i].long_price * 1.04
                            var short_risk = researchFile.data[i].short_price * 0.96
                        }
                        else {
                            var long_risk = researchFile.data[i].long_price;
                            var short_risk = researchFile.data[i].short_price;
                        }

                        var pair = {
                            "symbol": researchFile.data[i].name + "USDT",
                            "leverage": process.env.LEVERAGE,
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
        } else {
            console.log(chalk.red("No research data available. Cannot create settings."));
        }
    });
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
            if(process.env.UPDATE_MIN_ORDER_SIZING == "true") {
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
                        //console.log("Skipping " + out.data[i].name + "USDT");
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
            //if error load research.json file and update settings.json file
            }).catch(
                err => {
                    console.log(chalk.red("Research API down. Attempting to load research.json file, if this continues please contact @Crypt0gnoe or @Atsutane in Discord"));
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
                            try{
                                if (index === -1 || settingsIndex === 'undefined' || researchFile.data[i].name.includes("1000")) {
                                    //console.log("Skipping " + researchFile.data[i].name + "USDT");
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
                            catch(err){
                                console.log("Error updating " + researchFile.data[i].name + "USDT, this is likely due to not having this pair active in your settings.json file");
                            }
                        }
                        fs.writeFileSync('settings.json', JSON.stringify(settingsFile, null, 4));
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
    if(process.env.USE_DISCORD == "true") {
        discordService.sendOrderNotification(symbol, amount, side, position, pnl, qty);
    }
}


//message webhook
function messageWebhook(message, type = 'info') {
    if(process.env.USE_DISCORD == "true") {
        try {
            discordService.sendMessage(message, type);
        }
        catch(err){
            console.log(err);
        }
    }
}

//report webhook
async function reportWebhook() {
    if(process.env.USE_DISCORD == "true") {
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

        //get current timestamp and calculate bot uptime
        const timestampNow = moment();
        const timeUptimeInSeconds = timestampNow.diff(timestampBotStart, 'seconds');
        const times = calculateBotUptime(timeUptimeInSeconds);

        //fetch balance
        var balance = await getBalance();
        var diff = balance - startingBalance;
        var percentGain = (diff / startingBalance) * 100;
        var percentGain = percentGain.toFixed(6);
        var diff = diff.toFixed(6);
        var balance = balance.toFixed(2);
        //fetch positions
        var positions = await restClient.getPositionInfo({ category: 'linear', settleCoin: 'USDT' });
        var positionList = [];
        var openPositions = await totalOpenPositions();
        if(openPositions === null) {
            openPositions = 0;
        }
        var marg = await getMargin();
        var time = await getServerTime();
        console.log(positions.result.list);
        //loop through positions.result.list get open symbols with size > 0 calculate pnl and to array
        for (var i = 0; i < positions.result.list.length; i++) {
            if (positions.result.list[i].size > 0) {
                
                var pnl1 = positions.result.list[i].unrealisedPnl;
                var pnl = parseFloat(pnl1).toFixed(6);
                var symbol = positions.result.list[i].symbol;
                var size = positions.result.list[i].size;
                var liq = positions.result.list[i].liqPrice;
                var size = parseFloat(size).toFixed(4);
                var ios = positions.result.list[i].isIsolated;

                var priceFetch = await restClient.getTickers({ category: 'linear', symbol: symbol });
                var test = priceFetch.result.list[0].lastPrice;

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
            }
        }

        const uptimeString = times[0].toString() + " days " + times[1].toString() + " hr. " + times[2].toString() + " min. " + times[3].toString() + " sec.";
        
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
        }
        catch (err) {
            console.log(chalk.red("Discord Webhook Error"));
            console.log(err);
        }
    }
}


async function main() {
    console.log("Starting Lick Hunter!");
    try{
        pairs = await getSymbols();

        //load local file acccount.json with out require and see if "config_set" is true
        var account = JSON.parse(fs.readFileSync('account.json', 'utf8'));
        if (account.config_set == false) {
            var isSet = await setPositionMode();
            if (isSet == true) {
                //set to true and save
                account.config_set = true;
                fs.writeFileSync('account.json', JSON.stringify(account));
            }

        }

        if(process.env.UPDATE_MIN_ORDER_SIZING == "true") {
            await getMinTradingSize();
        }
        if (process.env.USE_SMART_SETTINGS.toLowerCase() == "true") {
            console.log("Updating settings.json with smart settings");
            await createSettings();
        }
        if (process.env.USE_SET_LEVERAGE.toLowerCase() == "true") {
            await setLeverage(pairs, process.env.LEVERAGE);
            
        }
    }
    catch (err) {
        console.log(chalk.red("Error in main()"));

        console.log(err);

        if (process.env.USE_DISCORD == "true")
            messageWebhook(err);
            
        await sleep(10000);
    }

    await liquidationEngine(pairs);

    while (true) {
        try {
            await getBalance();
            await updateSettings();
            await checkOpenPositions();
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
