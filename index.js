import express from 'express';
import { Telegraf } from 'telegraf';
import axios from 'axios';
import Database from 'better-sqlite3';

const BOT_TOKEN = process.env.BOT_TOKEN;
const HELIUS_SECRET = process.env.HELIUS_SECRET;
const PORT = process.env.PORT || 3000;

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// Initialize SQLite database to store group settings
const db = new Database('buybot.db');
db.exec(`CREATE TABLE IF NOT EXISTS groups (chat_id TEXT PRIMARY KEY, mint TEXT);`);

function setMint(chat_id, mint) {
  db.prepare('INSERT INTO groups (chat_id, mint) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET mint=excluded.mint').run(String(chat_id), mint);
}
function getGroups(mint) {
  return db.prepare('SELECT chat_id FROM groups WHERE mint=?').all(mint);
}

// Telegram bot commands
bot.start((ctx) => {
  ctx.reply('Bot is online. Use /setpair <mint> to bind a token.');
});

bot.command('setpair', (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  const mint = parts[1];
  if (!mint) return ctx.reply('Usage: /setpair <mint>');
  setMint(ctx.chat.id, mint);
  ctx.reply(`Token set to ${mint}`);
});

bot.launch();

// Health check route for Render
app.get('/', (req, res) => res.send('ok'));

// Webhook endpoint for Helius events
app.post('/helius', async (req, res) => {
  if (HELIUS_SECRET && req.headers['x-helius-secret'] !== HELIUS_SECRET) {
    return res.status(403).send('forbidden');
  }
  res.send('ok');
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const e of events) {
    const mint = e?.tokenTransfers?.[0]?.mint || e?.events?.swap?.tokenMintOut;
    const tokenOut = e?.events?.swap?.tokenAmountOut || e?.tokenTransfers?.[0]?.tokenAmount || 0;
    const sig = e?.signature;
    if (!mint || !tokenOut) continue;
    const groups = getGroups(mint);
    if (!groups.length) continue;
    try {
      const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const pair = data.pairs?.[0];
      if (!pair) continue;
      const priceUsd = Number(pair.priceUsd);
      const usd = tokenOut * priceUsd;
      for (const g of groups) {
        const msg = `Token ${mint} buy detected\nAmount: ${tokenOut}\nUSD: $${usd.toFixed(2)}\nTx: https://solscan.io/tx/${sig}`;
        await bot.telegram.sendMessage(g.chat_id, msg);
      }
    } catch (err) {
      console.error(err);
    }
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
