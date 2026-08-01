const { SlashCommandBuilder } = require('discord.js');
const { handleCancelVote } = require('../lib/queue8');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Start or vote on a match cancellation vote (5 votes needed)'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const result = await handleCancelVote(interaction.channelId, interaction.user.id);
    if (result.status === 'no_match') return interaction.editReply('❌ There is no active match.');
    if (result.status === 'not_in_match') return interaction.editReply('❌ You are not in the active match.');
    if (result.status === 'no_channel') return interaction.editReply('❌ Match channel not found.');
    if (result.status === 'cancelled') return interaction.editReply('🚫 Match cancelled.');
    await interaction.editReply(`🗳️ Your cancel vote has been counted (${result.count}/${result.needed}).`);
  },
};
