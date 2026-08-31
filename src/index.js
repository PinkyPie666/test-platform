const http = require('http');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { token } = require('./config');
const { LobbyManager } = require('./LobbyManager');

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const manager = new LobbyManager(client);

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  manager.hydrate().catch((error) => console.error('Hydration failed:', error.message));
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'lobby') {
      const sub = interaction.options.getSubcommand();
      if (sub === 'create') {
        await manager.createLobby(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      const [prefix, action, lobbyId, userId] = interaction.customId.split(':');
      if (prefix === 'afk' && action === 'modal') {
        const lobby = manager.getLobby(lobbyId);
        if (!lobby) {
          await interaction.reply({ content: 'Lobby not found.', ephemeral: true });
          return;
        }
        if (interaction.user.id !== userId) {
          await interaction.reply({ content: 'This apology is not for you.', ephemeral: true });
          return;
        }
        await interaction.deferReply({ ephemeral: true });
        await manager.restoreAfk(lobby, userId, interaction);
      }
      return;
    }

    if (!interaction.isButton()) return;

    const [prefix, action, ...rest] = interaction.customId.split(':');

    if (prefix === 'lobby') {
      const messageId = rest[0];
      const lobby = manager.getLobby(messageId);
      if (!lobby) {
        await interaction.reply({ content: 'This lobby no longer exists.', ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      if (action === 'join') {
        await manager.join(lobby, interaction.user, interaction);
      } else if (action === 'leave') {
        await manager.leave(lobby, interaction.user, interaction);
      } else if (action === 'ready') {
        if (interaction.user.id !== lobby.ownerId) {
          await interaction.editReply({ content: 'Only the host can start a ready check.' });
          return;
        }
        await manager.startReadyCheck(lobby, interaction.user, interaction);
      } else if (action === 'close') {
        if (!manager.canClose(lobby, interaction.member)) {
          await interaction.editReply({ content: 'Only the host or an administrator can close this lobby.' });
          return;
        }
        await manager.close(lobby, interaction.member, interaction);
      }
      return;
    }

    if (prefix === 'ready' && action === 'accept') {
      const lobbyId = rest[0];
      const lobby = manager.getLobby(lobbyId);
      if (!lobby) {
        await interaction.reply({ content: 'This ready check no longer exists.', ephemeral: true });
        return;
      }
      await interaction.deferUpdate();
      await manager.acceptReady(lobby, interaction.user, interaction);
      return;
    }

    if (prefix === 'afk') {
      const [lobbyId, userId] = rest;
      const lobby = manager.getLobby(lobbyId);
      if (!lobby) {
        await interaction.reply({ content: 'This lobby no longer exists.', ephemeral: true });
        return;
      }
      if (interaction.user.id !== userId) {
        await interaction.reply({ content: 'This prompt is not for you.', ephemeral: true });
        return;
      }
      if (action === 'apologize') {
        const modal = manager.buildApologyModal(lobby, userId);
        await interaction.showModal(modal);
      } else if (action === 'hellnah') {
        await interaction.deferReply({ ephemeral: true });
        await manager.confirmAfk(lobby, userId, interaction);
      }
    }
  } catch (error) {
    console.error('[Interaction] unhandled error:', error.message);
  }
});

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => res.end('Bot is alive!')).listen(PORT, () => {
  console.log(`Health check server listening on port ${PORT}`);
});

client.login(token);