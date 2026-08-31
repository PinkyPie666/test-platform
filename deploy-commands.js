const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { token, clientId, guildId } = require('./src/config');

const command = new SlashCommandBuilder()
  .setName('lobby')
  .setDescription('League of Legends party and queue manager')
  .addSubcommand((sub) =>
    sub.setName('create').setDescription('Create a new 5-man party lobby')
  )
  .toJSON();

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Deploying slash commands...');
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [command] });
      console.log(`Guild commands deployed for ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: [command] });
      console.log('Global commands deployed');
    }
  } catch (error) {
    console.error('Failed to deploy commands:', error);
    process.exit(1);
  }
})();