import { WebhookClient, EmbedBuilder } from 'discord.js';

class DiscordService {
    constructor(webhookUrl) {
        this.webhookClient = new WebhookClient({ url: webhookUrl });
    }

    async close() {
        try {
            if (this.webhookClient) {
                await this.webhookClient.destroy();
                console.log("Discord webhook client closed");
            }
        } catch (error) {
            console.error("Error closing Discord webhook client:", error.message);
        }
    }

    async sendOrderNotification(symbol, amount, side, position, pnl, qty) {
        try {
            const isBuy = side === "Buy";
            const color = isBuy ? 0x00ff00 : 0xff0000;
            const emoji = isBuy ? "🟢" : "🔴";
            const direction = isBuy ? "LONG" : "SHORT";
            const counterDirection = isBuy ? "SHORT" : "LONG";
            
            const embed = new EmbedBuilder()
                .setTitle(`${emoji} NEW TRADE ${emoji}`)
                .setDescription(`**${symbol}** - ${counterDirection} Liquidation → ${direction} Entry`)
                .setColor(color)
                .addFields(
                    { name: '📊 Symbol', value: `\`${symbol}\``, inline: true },
                    { name: '💰 Order Size', value: `\`${amount.toFixed(4)}\``, inline: true },
                    { name: '📈 Liquidation Volume', value: `\`${qty.toFixed(2)} USDT\``, inline: true },
                )
                .setTimestamp()
                .setFooter({ text: '0xLIQD-BYBIT' });

            await this.webhookClient.send({ embeds: [embed] });
        } catch (err) {
            console.error("Discord Webhook Error:", err.message);
        }
    }

    async sendMessage(message, type = 'info') {
        try {
            const colors = {
                info: 0x00ffff,
                warning: 0xffff00,
                error: 0xff0000,
                success: 0x00ff00
            };

            const emojis = {
                info: 'ℹ️',
                warning: '⚠️',
                error: '❌',
                success: '✅'
            };

            const embed = new EmbedBuilder()
                .setTitle(`${emojis[type]} Alert`)
                .setDescription(message)
                .setColor(colors[type] || colors.info)
                .setTimestamp()
                .setFooter({ text: '0xLIQD-BYBIT' });

            await this.webhookClient.send({ embeds: [embed] });
        } catch (err) {
            console.error("Discord Webhook Error:", err);
        }
    }

    async sendReport(balance, leverage, margin, profit, profitPercent, uptime, serverTime, positions, openPositionsCount) {
        try {
            const embed = new EmbedBuilder()
                .setTitle('📊 0xLIQD-BYBIT REPORT 📊')
                .setDescription('**Bot Status Report**')
                .setColor(0x9966cc)
                .addFields(
                    { name: '💰 Account Balance', value: `\`\`\`autohotkey\n${balance} USDT\`\`\``, inline: true },
                    { name: '⚖️ Leverage', value: `\`\`\`autohotkey\n${leverage}x\`\`\``, inline: true },
                    { name: '📊 Total USDT in Positions', value: `\`\`\`autohotkey\n${margin} USDT\`\`\``, inline: true },
                    { name: '💵 Profit USDT', value: `\`\`\`autohotkey\n${profit} USDT\`\`\``, inline: true },
                    { name: '📈 Profit %', value: `\`\`\`autohotkey\n${profitPercent}%\`\`\``, inline: true },
                    { name: '⏱️ Bot Uptime', value: `\`\`\`autohotkey\n${uptime}\`\`\``, inline: true },
                    { name: '🕐 Server Time', value: `\`\`\`autohotkey\n${serverTime}\`\`\``, inline: true }
                )
                .setFooter({ text: `Open Positions: ${openPositionsCount}` })
                .setTimestamp();

            // Add position details
            if (positions.length > 0) {
                embed.addFields({
                    name: '📊 Open Positions',
                    value: positions.map(pos => {
                        const emoji = pos.side.includes('✅Long') ? '🟢' : '🔴';
                        return `${emoji} **${pos.symbol}**\n   Size: ${pos.size} | P&L: ${pos.pnl} USDT\n   Entry: ${pos.price} | TP: ${pos.take_profit} | SL: ${pos.stop_loss || 'N/A'}`;
                    }).join('\n\n'),
                    inline: false
                });
            } else {
                embed.addFields({
                    name: '📊 Open Positions',
                    value: 'No active positions',
                    inline: false
                });
            }

            // Send with timeout protection
            await Promise.race([
                this.webhookClient.send({ embeds: [embed] }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Discord webhook timeout')), 15000))
            ]);
        } catch (err) {
            console.error("Discord Webhook Error:", err);
            throw err; // Re-throw to be caught by caller
        }
    }
}

export default DiscordService;