const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { resetPlayer, resetAll } = require('../lib/queue_ratings');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('8sreset')
    .setDescription('Reset 8s queue ratings (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('player')
        .setDescription('Reset a single player\'s rating')
        .addUserOption(o => o.setName('player').setDescription('Player to reset').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('all')
        .setDescription('Reset ALL player ratings for this server')
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();

    if (sub === 'player') {
      const target = interaction.options.getUser('player');
      resetPlayer(interaction.guildId, target.id);
      return interaction.editReply(`✅ Reset **${target.displayName}**'s rating.`);
    }

    if (sub === 'all') {
      resetAll(interaction.guildId);
      return interaction.editReply('✅ All 8s ratings have been reset.');
    }
  },
};
