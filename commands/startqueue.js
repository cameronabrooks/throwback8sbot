const { SlashCommandBuilder } = require('discord.js');
const { startQueue } = require('../lib/queue8');
const GAME_MAPS = require('../config/game_maps.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('startqueue')
    .setDescription('Post an 8s queue')
    .addStringOption(o => o.setName('game').setDescription('Which game to draw maps from').setRequired(true)
      .addChoices(...Object.entries(GAME_MAPS).map(([value, { label }]) => ({ name: label, value }))))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post the queue in').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const game = interaction.options.getString('game');
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    await startQueue(channel, false, game);
    await interaction.editReply(`✅ **${GAME_MAPS[game].label}** queue posted in ${channel}.`);
  },
};
