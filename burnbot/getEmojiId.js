// Prints the custom_emoji_id of any custom emoji you recently sent to the bot.
//
// 1) Make sure TG_BOT_TOKEN is set in .env (the bot that will post burns).
// 2) In Telegram, send the custom 🦊 emoji as a message TO that bot (DM it).
// 3) Run:  node getEmojiId.js
// 4) Copy the printed id into CUSTOM_EMOJI_ID in .env.
//
// Note: the launch/announce bot must be able to use the emoji — custom emoji
// render for Telegram Premium viewers; everyone else sees the fallback char.
import 'dotenv/config';

const token = (process.env.TG_BOT_TOKEN || '').trim();
if (!token) { console.error('Set TG_BOT_TOKEN in .env first.'); process.exit(1); }

const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(20000) });
const j = await r.json();
if (!j.ok) { console.error('getUpdates failed:', j.description || r.status); process.exit(1); }

let found = 0;
for (const u of j.result || []) {
  const msg = u.message || u.channel_post;
  const ents = (msg && (msg.entities || msg.caption_entities)) || [];
  for (const e of ents) {
    if (e.type === 'custom_emoji') {
      const text = msg.text || msg.caption || '';
      const ch = [...text].slice(e.offset, e.offset + e.length).join('');
      console.log(`custom_emoji_id: ${e.custom_emoji_id}   (fallback char: ${ch})`);
      found++;
    }
  }
}
if (!found) console.log('No custom emoji found in recent updates. Send the 🦊 emoji as a DM to the bot, then re-run. (If it still shows nothing, the bot may have a webhook set, or the message scrolled out of the 24h getUpdates window.)');
