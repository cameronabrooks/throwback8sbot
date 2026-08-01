const { SlashCommandBuilder } = require('discord.js');
const { stop } = require('../lib/musicPlayer');
const { canUseMusic } = require('../lib/musicPermissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop music and leave the voice channel'),

  async execute(interaction) {
    if (!canUseMusic(interaction.member)) {
      return interaction.reply({ content: '❌ You need the VIP or Staff role to use music commands.', ephemeral: true });
    }
    stop(interaction.guildId);
    await interaction.reply('⏹️ Stopped and disconnected.');
  }
};
