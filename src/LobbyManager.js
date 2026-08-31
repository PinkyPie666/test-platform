const fs = require('fs');
const path = require('path');
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'lobbies.json');
const READY_TIMEOUT_MS = 20000;

class LobbyManager {
  constructor(client) {
    this.client = client;
    this.lobbies = new Map();
    this._ensureDataDir();
    this._load();
  }

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      for (const item of data) {
        item._promise = Promise.resolve();
        item.messageObject = null;
        item.readyCheck = null;
        this.lobbies.set(item.messageId, item);
      }
    } catch {
      // No state file yet
    }
  }

  save() {
    const data = [];
    for (const lobby of this.lobbies.values()) {
      data.push({
        messageId: lobby.messageId,
        channelId: lobby.channelId,
        guildId: lobby.guildId,
        ownerId: lobby.ownerId,
        ownerUsername: lobby.ownerUsername,
        members: lobby.members,
        queue: lobby.queue,
        capacity: lobby.capacity,
        game: lobby.game,
      });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  }

  async hydrate() {
    for (const lobby of this.lobbies.values()) {
      try {
        const channel = await this.client.channels.fetch(lobby.channelId);
        const message = await channel.messages.fetch(lobby.messageId);
        lobby.messageObject = message;
        lobby.readyCheck = null;
        await this._refresh(lobby);
      } catch {
        this.lobbies.delete(lobby.messageId);
      }
    }
    this.save();
  }

  async createLobby(interaction) {
    const capacity = 5;
    const game = 'League of Legends';
    const message = await interaction.reply({
      content: 'Creating lobby...',
      fetchReply: true,
    });
    const lobby = {
      messageId: message.id,
      channelId: message.channelId,
      guildId: interaction.guildId,
      ownerId: interaction.user.id,
      ownerUsername: interaction.user.username,
      members: [],
      queue: [],
      capacity,
      game,
      _promise: Promise.resolve(),
      messageObject: message,
      readyCheck: null,
    };
    this.lobbies.set(message.id, lobby);
    this.save();
    await this._refresh(lobby);
  }

  getLobby(messageId) {
    return this.lobbies.get(messageId);
  }

  _queue(lobby, action) {
    lobby._promise = lobby._promise.then(action).catch((error) => {
      console.error(`[Lobby ${lobby.messageId}] operation failed:`, error.message);
    });
    return lobby._promise;
  }

  join(lobby, user, interaction) {
    return this._queue(lobby, () => this._doJoin(lobby, user, interaction));
  }

  async _doJoin(lobby, user, interaction) {
    if (lobby.members.some((m) => m.id === user.id)) {
      await this._notify(interaction, 'You are already in the party.');
      return;
    }
    if (lobby.queue.some((m) => m.id === user.id)) {
      const position = lobby.queue.findIndex((m) => m.id === user.id) + 1;
      await this._notify(interaction, `You are already in the queue at position #${position}.`);
      return;
    }
    if (lobby.members.length < lobby.capacity) {
      lobby.members.push({ id: user.id, username: user.username });
      await this._notify(interaction, 'You joined the party.');
    } else {
      lobby.queue.push({ id: user.id, username: user.username });
      await this._notify(interaction, `Party is full. You were added to the queue at #${lobby.queue.length}.`);
    }
    this.save();
    await this._refresh(lobby);
  }

  leave(lobby, user, interaction) {
    return this._queue(lobby, () => this._doLeave(lobby, user, interaction));
  }

  async _doLeave(lobby, user, interaction) {
    const partyIndex = lobby.members.findIndex((m) => m.id === user.id);
    const queueIndex = lobby.queue.findIndex((m) => m.id === user.id);
    if (partyIndex === -1 && queueIndex === -1) {
      await this._notify(interaction, 'You are not in this lobby.');
      return;
    }
    if (partyIndex !== -1) {
      lobby.members.splice(partyIndex, 1);
      await this._removeFromReadyCheck(lobby, user.id);
      if (lobby.queue.length > 0) {
        const promoted = lobby.queue.shift();
        lobby.members.push(promoted);
        await this._mentionPromotion(lobby, promoted);
      }
      await this._notify(interaction, 'You left the party.');
    } else {
      lobby.queue.splice(queueIndex, 1);
      await this._notify(interaction, 'You left the queue.');
    }
    this.save();
    await this._refresh(lobby);
  }

  close(lobby, member, interaction) {
    return this._queue(lobby, () => this._doClose(lobby, member, interaction));
  }

  async _doClose(lobby, member, interaction) {
    const isHost = member.user.id === lobby.ownerId;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    if (!isHost && !isAdmin) {
      await this._notify(interaction, 'Only the host or an administrator can close the lobby.');
      return;
    }
    this._clearReadyCheck(lobby);
    try {
      await lobby.messageObject.delete();
    } catch (error) {
      console.error(`[Lobby ${lobby.messageId}] failed to delete message:`, error.message);
    }
    this.lobbies.delete(lobby.messageId);
    this.save();
    await this._notify(interaction, 'Lobby closed.');
  }

  canClose(lobby, member) {
    return member.user.id === lobby.ownerId || member.permissions.has(PermissionFlagsBits.Administrator);
  }

  startReadyCheck(lobby, user, interaction) {
    return this._queue(lobby, () => this._doStartReadyCheck(lobby, user, interaction));
  }

  async _doStartReadyCheck(lobby, user, interaction) {
    if (lobby.readyCheck) {
      await this._notify(interaction, 'A ready check is already running.');
      return;
    }
    if (lobby.members.length === 0) {
      await this._notify(interaction, 'The party is empty.');
      return;
    }
    const partyIds = new Set(lobby.members.map((m) => m.id));
    const readyCheck = {
      messageId: null,
      messageObject: null,
      startTime: Date.now(),
      partyIds,
      pendingIds: new Set(partyIds),
      accepted: new Map(),
      ended: false,
      timer: setTimeout(() => this._queue(lobby, () => this._endReadyCheck(lobby)), READY_TIMEOUT_MS),
    };
    try {
      const channel = await this.client.channels.fetch(lobby.channelId);
      const message = await channel.send({
        embeds: [this._buildReadyCheckEmbed(lobby, readyCheck)],
        components: [this._buildReadyCheckRow(lobby.messageId)],
      });
      readyCheck.messageId = message.id;
      readyCheck.messageObject = message;
    } catch (error) {
      clearTimeout(readyCheck.timer);
      console.error(`[Lobby ${lobby.messageId}] failed to send ready check:`, error.message);
      await this._notify(interaction, 'Failed to start ready check.');
      return;
    }
    lobby.readyCheck = readyCheck;
    await this._notify(interaction, 'Ready check started. You have 20 seconds.');
  }

  acceptReady(lobby, user, interaction) {
    return this._queue(lobby, () => this._doAcceptReady(lobby, user, interaction));
  }

  async _doAcceptReady(lobby, user, interaction) {
    const rc = lobby.readyCheck;
    if (!rc || rc.ended) {
      await interaction.followUp({ content: 'No active ready check.', ephemeral: true });
      return;
    }
    if (!rc.partyIds.has(user.id)) {
      await interaction.followUp({ content: 'You are not part of this ready check.', ephemeral: true });
      return;
    }
    if (!rc.pendingIds.has(user.id)) {
      if (rc.accepted.has(user.id)) {
        await interaction.followUp({ content: 'You already accepted.', ephemeral: true });
      } else {
        await interaction.followUp({ content: 'You are not in this ready check.', ephemeral: true });
      }
      return;
    }
    const responseTimeMs = Date.now() - rc.startTime;
    rc.pendingIds.delete(user.id);
    rc.accepted.set(user.id, { id: user.id, username: user.username, responseTimeMs });
    await this._refreshReadyCheck(lobby);
    if (rc.pendingIds.size === 0) {
      await this._endReadyCheck(lobby);
    }
  }

  async _endReadyCheck(lobby) {
    const rc = lobby.readyCheck;
    if (!rc || rc.ended) return;
    rc.ended = true;
    if (rc.timer) clearTimeout(rc.timer);
    try {
      if (rc.messageObject) await rc.messageObject.edit({ components: [] });
    } catch (error) {
      console.error(`[Lobby ${lobby.messageId}] failed to disable accept button:`, error.message);
    }
    const afkMembers = [];
    for (const userId of rc.pendingIds) {
      const member = lobby.members.find((m) => m.id === userId);
      if (member) {
        member.afkPenalty = true;
        afkMembers.push(member);
      }
    }
    if (afkMembers.length > 0) {
      this.save();
      await this._refresh(lobby);
      for (const member of afkMembers) {
        await this._sendAfkPrompt(lobby, member);
      }
    }
    lobby.readyCheck = null;
  }

  async _removeFromReadyCheck(lobby, userId) {
    const rc = lobby.readyCheck;
    if (!rc || rc.ended) return;
    rc.pendingIds.delete(userId);
    rc.accepted.delete(userId);
    if (rc.pendingIds.size === 0) {
      await this._endReadyCheck(lobby);
    } else {
      await this._refreshReadyCheck(lobby);
    }
  }

  _clearReadyCheck(lobby) {
    const rc = lobby.readyCheck;
    if (!rc) return;
    if (rc.timer) clearTimeout(rc.timer);
    try {
      if (rc.messageObject) rc.messageObject.delete();
    } catch {}
    lobby.readyCheck = null;
  }

  buildApologyModal(lobby, userId) {
    const modal = new ModalBuilder()
      .setCustomId(`afk:modal:${lobby.messageId}:${userId}`)
      .setTitle('Apologize for going AFK');
    const input = new TextInputBuilder()
      .setCustomId('apologyInput')
      .setLabel('What do you want to say?')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('Sorry for going AFK...')
      .setRequired(false)
      .setMaxLength(100);
    const row = new ActionRowBuilder().addComponents(input);
    modal.addComponents(row);
    return modal;
  }

  restoreAfk(lobby, userId, interaction) {
    return this._queue(lobby, () => this._doRestoreAfk(lobby, userId, interaction));
  }

  async _doRestoreAfk(lobby, userId, interaction) {
    const member = lobby.members.find((m) => m.id === userId);
    if (!member) {
      await this._notify(interaction, 'You are not in the party.');
      return;
    }
    member.afkPenalty = false;
    this.save();
    await this._refresh(lobby);
    const text = interaction.fields?.getTextInputValue?.('apologyInput');
    await this._notify(interaction, text ? 'Apology accepted. Your name is restored.' : 'Okay, your name is restored.');
  }

  confirmAfk(lobby, userId, interaction) {
    return this._queue(lobby, () => this._doConfirmAfk(lobby, userId, interaction));
  }

  async _doConfirmAfk(lobby, userId, interaction) {
    const member = lobby.members.find((m) => m.id === userId);
    if (!member) {
      await this._notify(interaction, 'You are not in the party.');
      return;
    }
    member.afkPenalty = true;
    this.save();
    await this._refresh(lobby);
    await this._notify(interaction, '[AFK Gay] it is.');
  }

  async _mentionPromotion(lobby, user) {
    try {
      const channel = await this.client.channels.fetch(lobby.channelId);
      await channel.send({
        content: `<@${user.id}> has been promoted from the queue into the party!`,
        allowedMentions: { users: [user.id] },
      });
    } catch (error) {
      console.error(`[Lobby ${lobby.messageId}] failed to send promotion mention:`, error.message);
    }
  }

  async _sendAfkPrompt(lobby, member) {
    try {
      const channel = await this.client.channels.fetch(lobby.channelId);
      const embed = new EmbedBuilder()
        .setTitle('AFK Penalty')
        .setDescription(`<@${member.id}> failed to accept the match in time.`)
        .setColor(0xed4245);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`afk:apologize:${lobby.messageId}:${member.id}`)
          .setLabel('พิมพ์ขอโทษ (Apologize)')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🙇‍♂️'),
        new ButtonBuilder()
          .setCustomId(`afk:hellnah:${lobby.messageId}:${member.id}`)
          .setLabel('Hell Nah (ไม่พิมพ์เว้ย)')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🖕')
      );
      await channel.send({
        content: `<@${member.id}>`,
        embeds: [embed],
        components: [row],
        allowedMentions: { users: [member.id] },
      });
    } catch (error) {
      console.error(`[Lobby ${lobby.messageId}] failed to send AFK prompt:`, error.message);
    }
  }

  async _notify(interaction, text) {
    try {
      await interaction.editReply({ content: text });
    } catch {
      try {
        await interaction.followUp({ content: text, ephemeral: true });
      } catch {}
    }
  }

  async _refresh(lobby) {
    try {
      const embed = this._buildEmbed(lobby);
      const row = this._buildRow(lobby.messageId);
      await lobby.messageObject.edit({
        content: null,
        embeds: [embed],
        components: [row],
      });
    } catch (error) {
      console.error(`[Lobby ${lobby.messageId}] failed to refresh message:`, error.message);
    }
  }

  async _refreshReadyCheck(lobby) {
    const rc = lobby.readyCheck;
    if (!rc || rc.ended || !rc.messageObject) return;
    try {
      await rc.messageObject.edit({
        embeds: [this._buildReadyCheckEmbed(lobby, rc)],
        components: [this._buildReadyCheckRow(lobby.messageId)],
      });
    } catch (error) {
      console.error(`[Lobby ${lobby.messageId}] failed to refresh ready check:`, error.message);
    }
  }

  _buildEmbed(lobby) {
    const status =
      lobby.members.length >= lobby.capacity
        ? `Party Full [${lobby.members.length}/${lobby.capacity}]`
        : `Looking for Players [${lobby.members.length}/${lobby.capacity}]`;
    const partyField = lobby.members.length
      ? lobby.members
          .map((m, i) => `${i + 1}. <@${m.id}> (${m.afkPenalty ? `${m.username} [AFK Gay]` : m.username})`)
          .join('\n')
      : 'No members yet';
    const queueField = lobby.queue.length
      ? lobby.queue.map((m, i) => `#${i + 1} <@${m.id}> (${m.username})`).join('\n')
      : 'Queue is empty';
    const host =
      lobby.ownerUsername ??
      this.client.users.cache.get(lobby.ownerId)?.username ??
      'Unknown';
    return new EmbedBuilder()
      .setTitle(`${lobby.game} Party Lobby`)
      .setDescription(status)
      .addFields(
        { name: 'Current Party', value: partyField, inline: true },
        { name: 'Waiting Queue', value: queueField, inline: true }
      )
      .setFooter({ text: `Host: ${host} | Lobby: ${lobby.messageId}` })
      .setColor(lobby.members.length >= lobby.capacity ? 0x57f287 : 0x5865f2)
      .setTimestamp();
  }

  _buildRow(messageId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`lobby:join:${messageId}`)
        .setLabel('Join Party / Queue')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🎮'),
      new ButtonBuilder()
        .setCustomId(`lobby:leave:${messageId}`)
        .setLabel('Leave Party')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🚪'),
      new ButtonBuilder()
        .setCustomId(`lobby:ready:${messageId}`)
        .setLabel('Ready Check')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('⚡'),
      new ButtonBuilder()
        .setCustomId(`lobby:close:${messageId}`)
        .setLabel('Close Lobby')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❌')
    );
  }

  _buildReadyCheckEmbed(lobby, readyCheck) {
    const elapsed = Date.now() - readyCheck.startTime;
    const remaining = Math.max(0, READY_TIMEOUT_MS - elapsed);
    const accepted = [...readyCheck.accepted.values()].sort((a, b) => a.responseTimeMs - b.responseTimeMs);
    const medals = ['🥇', '🥈', '🥉'];
    const acceptedField = accepted.length
      ? accepted
          .map((m, i) => {
            const rank = medals[i] ?? `${i + 1}.`;
            return `${rank} <@${m.id}> — ${(m.responseTimeMs / 1000).toFixed(2)}s`;
          })
          .join('\n')
      : 'No one has accepted yet';
    const pending = lobby.members
      .filter((m) => readyCheck.pendingIds.has(m.id))
      .map((m) => `⏳ <@${m.id}> - Pending...`)
      .join('\n') || 'None';
    const endedText = readyCheck.ended ? 'Ready check has ended.' : `Time remaining: ${(remaining / 1000).toFixed(1)}s`;
    const color = readyCheck.ended ? 0xed4245 : remaining <= 5000 ? 0xed4245 : 0xfee75c;
    return new EmbedBuilder()
      .setTitle('Ready Check — ACCEPT MATCH')
      .setDescription(endedText)
      .addFields(
        { name: 'Accepted (Fastest to Slowest)', value: acceptedField, inline: true },
        { name: 'Pending', value: pending, inline: true }
      )
      .setColor(color)
      .setTimestamp();
  }

  _buildReadyCheckRow(lobbyId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ready:accept:${lobbyId}`)
        .setLabel('ACCEPT MATCH')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🟢')
    );
  }
}

module.exports = { LobbyManager };