require('dotenv').config();

const { BOT_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!BOT_TOKEN || !CLIENT_ID) {
  throw new Error('BOT_TOKEN and CLIENT_ID must be provided in .env');
}

module.exports = {
  token: BOT_TOKEN,
  clientId: CLIENT_ID,
  guildId: GUILD_ID || null,
};