const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { banPlayer, unbanPlayer, getBan } = require('../lib/queue_ratings');

const DURATION_UNITS = {
  minutes: 60 * 1000,
  hours:   60 * 60 * 1000,
  days:    24 * 60 * 60 * 1000,
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('8sban')
    .setDescription('Manage 8s queue bans (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Permanently ban a player from the 8s queue')
        .addUserOption(o => o.setName('player').setDescription('Player to ban').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('temp')
        .setDescription('Temporarily ban a player from the 8s queue')
        .addUserOption(o => o.setName('player').setDescription('Player to ban').setRequired(true))
        .addIntegerOption(o => o.setName('duration').setDescription('Duration amount').setRequired(true).setMinValue(1))
        .addStringOption(o =>
          o.setName('unit').setDescription('Duration unit').setRequired(true)
            .addChoices(
              { name: 'Minutes', value: 'minutes' },
              { name: 'Hours',   value: 'hours' },
              { name: 'Days',    value: 'days' },
            )
        )
        .addStringOption(o => o.setName('reason').setDescription('Reason for the ban').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('Unban a player from the 8s queue')
        .addUserOption(o => o.setName('player').setDescription('Player to unban').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('check')
        .setDescription('Check if a player is banned from the 8s queue')
        .addUserOption(o => o.setName('player').setDescription('Player to check').setRequired(true))
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getUser('player');

    if (sub === 'add') {
      const reason = interaction.options.getString('reason') ?? null;
      banPlayer(interaction.guildId, target.id, reason, interaction.user.id, null);
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🚫 8s Queue Ban')
        .addFields(
          { name: 'Player',    value: `<@${target.id}>`, inline: true },
          { name: 'Banned By', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Duration',  value: 'Permanent' },
          { name: 'Reason',    value: reason ?? 'No reason provided' },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'temp') {
      const duration = interaction.options.getInteger('duration');
      const unit = interaction.options.getString('unit');
      const reason = interaction.options.getString('reason') ?? null;
      const expiresAt = Date.now() + duration * DURATION_UNITS[unit];
      banPlayer(interaction.guildId, target.id, reason, interaction.user.id, expiresAt);
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('⏳ 8s Queue Temp Ban')
        .addFields(
          { name: 'Player',    value: `<@${target.id}>`, inline: true },
          { name: 'Banned By', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Expires',   value: `<t:${Math.floor(expiresAt / 1000)}:R>` },
          { name: 'Reason',    value: reason ?? 'No reason provided' },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    if (sub === 'remove') {
      const removed = unbanPlayer(interaction.guildId, target.id);
      if (!removed) return interaction.editReply(`❌ **${target.displayName}** is not banned.`);
      return interaction.editReply(`✅ **${target.displayName}** has been unbanned from the 8s queue.`);
    }

    if (sub === 'check') {
      const ban = getBan(interaction.guildId, target.id);
      if (!ban) return interaction.editReply(`✅ **${target.displayName}** is not banned.`);
      const embed = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🚫 Player is Banned')
        .addFields(
          { name: 'Player',    value: `<@${target.id}>`, inline: true },
          { name: 'Banned By', value: ban.banned_by ? `<@${ban.banned_by}>` : 'System', inline: true },
          { name: 'Duration',  value: ban.expires_at ? `Temporary — expires <t:${Math.floor(ban.expires_at / 1000)}:R>` : 'Permanent' },
          { name: 'Reason',    value: ban.reason ?? 'No reason provided' },
          { name: 'Banned At', value: `<t:${Math.floor(ban.banned_at / 1000)}:F>` },
        )
        .setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }
  },
};
