// index.js — 最小可跑版（Express + Telegraf + Helius webhook）
import express from "express";
import axios from "axios";
import Database from "better-sqlite3";
import { Telegraf, Markup } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const HELIUS_SECRET = process.env.HELIUS_SECRET || "";
if (!BOT_TOKEN) throw new Error("Missing BOT_TOKEN env");

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// --- DB ---
const db = new Database("buybot.db");
db.exec(`
CREATE TABLE IF NOT EXISTS groups(
  chat_id TEXT PRIMARY KEY,
  mint TEXT,
  emoji TEXT DEFAULT '🟢',
  min_buy_usd REAL DEFAULT 15,
  step_usd REAL DEFAULT 3,
  whale_usd REAL DEFAULT 1000,
  whale_on INTEGER DEFAULT 1,
  website TEXT, twitter TEXT,
  banner_file_id TEXT,
  ads_off INTEGER DEFAULT 0
);
`);
const getGroup = (chatId) =>
  db.prepare("SELECT * FROM groups WHERE chat_id=?").get(String(chatId));
const upsertGroup = db.prepare(`
INSERT INTO groups(chat_id,mint,emoji,min_buy_usd,step_usd,whale_usd,whale_on,website,twitter,banner_file_id,ads_off)
VALUES(@chat_id,@mint,@emoji,@min_buy_usd,@step_usd,@whale_usd,@whale_on,@website,@twitter,@banner_file_id,@ads_off)
ON CONFLICT(chat_id) DO UPDATE SET
 mint=excluded.mint, emoji=excluded.emoji, min_buy_usd=excluded.min_buy_usd, step_usd=excluded.step_usd,
 whale_usd=excluded.whale_usd, whale_on=excluded.whale_on, website=excluded.website,
 twitter=excluded.twitter, banner_file_id=excluded.banner_file_id, ads_off=excluded.ads_off
`);

// --- Helpers ---
const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const emojify = (usd, step, emoji) =>
  Array(Math.max(1, Math.min(30, Math.floor(usd / step)))).fill(emoji).join("");

async function fetchDexScreenerByMint(mint){
  const { data } = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 7000 });
  const pair = data?.pairs?.[0];
  if (!pair) return null;
  return {
    priceUsd: Number(pair.priceUsd || 0),
    marketCap: pair.fdv || pair.marketCap || null,
    dexUrl: pair.url,
    baseSymbol: pair.baseToken?.symbol || "TOKEN",
  };
}

// --- Bot commands ---
bot.start((ctx)=> ctx.reply(
  "买单播报 Bot 就约：\n/setpair <mint>\n/setup 打开设置面板\n"
));
bot.command("setpair", (ctx)=>{
  const mint = ctx.message.text.split(/\s+/)[1];
  if (!mint) return ctx.reply("用法：/setpair <mint地址>");
  const row = getGroup(ctx.chat.id) || { chat_id: String(ctx.chat.id) };
  row.mint = mint;
  upsertGroup.run(row);
  ctx.reply(`已绑定代币：${mint}\n部署好后到 Helius 把 webhook 指到 /helius。`);
});
bot.command("setup", async (ctx)=>{
  const row = getGroup(ctx.chat.id) || { chat_id: String(ctx.chat.id) };
  upsertGroup.run(row);
  await ctx.reply(
    `Setup your Buybot. Current emoji: ${row.emoji}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🟢 Buy Emoji","cfg_emoji"),
       Markup.button.callback("Min Buy","cfg_min")],
      [Markup.button.callback("Buy Step","cfg_step"),
       Markup.button.callback(`🐋 Whale ${row.whale_on?'✅':'❌'}`,"cfg_whale")],
      [Markup.button.callback("🌐 Website","cfg_site"),
       Markup.button.callback("Twitter [X]","cfg_twitter")],
      [Markup.button.callback("✅ Done","cfg_done")]
    ])
  );
});
const sessions = new Map(); // 极简“下一条文本”会话
bot.on("callback_query", async (ctx)=>{
  const d = ctx.update.callback_query.data;
  await ctx.answerCbQuery();
  const id = ctx.chat.id;
  const row = getGroup(id) || { chat_id: String(id) };
  if (d==="cfg_emoji"){ sessions.set(id,"emoji"); return ctx.reply("发送一个表情作为买单堆叠符号"); }
  if (d==="cfg_min"){ sessions.set(id,"min"); return ctx.reply("发送最小播报金额(USD)，例如 15"); }
  if (d==="cfg_step"){ sessions.set(id,"step"); return ctx.reply("发送步进金额(USD)，例如 3"); }
  if (d==="cfg_site"){ sessions.set(id,"site"); return ctx.reply("发送官网链接"); }
  if (d==="cfg_twitter"){ sessions.set(id,"tw"); return ctx.reply("发送 Twitter 链接"); }
  if (d==="cfg_whale"){ row.whale_on = row.whale_on?0:1; upsertGroup.run(row); return ctx.reply(`鲸龟提醒：${row.whale_on?'开启':'关闭'}`); }
  if (d==="cfg_done"){ return ctx.reply("✅ 配置完成"); }
});
bot.on("text", (ctx)=>{
  const mode = sessions.get(ctx.chat.id);
  if (!mode) return;
  const row = getGroup(ctx.chat.id) || { chat_id: String(ctx.chat.id) };
  const v = ctx.message.text.trim();
  if (mode==="emoji") row.emoji = v;
  if (mode==="min") row.min_buy_usd = Number(v)||row.min_buy_usd||15;
  if (mode==="step") row.step_usd = Number(v)||row.step_usd||3;
  if (mode==="site") row.website = v;
  if (mode==="tw") row.twitter = v;
  upsertGroup.run(row);
  sessions.delete(ctx.chat.id);
  ctx.reply("✅ 已更新");
});

// --- Helius webhook ---
app.post("/helius", async (req,res)=>{
  try{
    if (HELIUS_SECRET && req.headers["x-helius-secret"] !== HELIUS_SECRET){
      return res.sendStatus(403);
    }
    res.send("ok");
    const events = Array.isArray(req.body)? req.body : [req.body];
    for (const e of events){
      const mint = e?.tokenTransfers?.[0]?.mint || e?.events?.swap?.tokenMintOut;
      const tokenOut = e?.events?.swap?.tokenAmountOut || e?.tokenTransfers?.[0]?.tokenAmount || 0;
      const sig = e?.signature;
      if (!mint || !tokenOut) continue;

      // 找订阅了该 mint 的所有群
      const rows = db.prepare("SELECT * FROM groups WHERE mint=?").all(mint);
      if (!rows.length) continue;

      const info = await fetchDexScreenerByMint(mint);
      if (!info || !info.priceUsd) continue;

      const usd = tokenOut * info.priceUsd;
      for (const g of rows){
        if (usd < (g.min_buy_usd ?? 15)) continue;
        const stack = emojify(usd, g.step_usd ?? 3, g.emoji ?? "🟢");
        const mc = info.marketCap ? `$${fmt(info.marketCap)}` : "—";
        const text =
`*NEW BUY*
*${info.baseSymbol}* Buy!
${stack}

💵 $${fmt(usd)} | 🪙 Got: ${fmt(tokenOut)} ${info.baseSymbol}
👤 Buyer | [Txn](https://solscan.io/tx/${sig})
🏷 Market Cap: ${mc}`;
        await bot.telegram.sendMessage(g.chat_id, text, {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.url("Buy", `https://jup.ag/swap/SOL-${mint}`),
             Markup.button.url("DexS", info.dexUrl || `https://dexscreener.com/solana/${mint}`)],
            [(g.website? Markup.button.url("Website", g.website): null),
             (g.twitter? Markup.button.url("Twitter [X]", g.twitter): null)
            ].filter(Boolean)
          ])
        });
        if ((g.whale_on??1) && usd >= (g.whale_usd??1000)){
          await bot.telegram.sendMessage(g.chat_id, `🐋 *Whale Buy* $${fmt(usd)}!`, { parse_mode:"Markdown" });
        }
      }
    }
  }catch(err){ console.error(err); res.send("ok"); }
});

// 健康检查（Render 必须有）
app.get("/", (_req,res)=> res.send("ok"));

// 启动
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log("Webhook server on", PORT));
bot.launch();
process.on("SIGINT", ()=> bot.stop("SIGINT"));
process.on("SIGTERM", ()=> bot.stop("SIGTERM"));
