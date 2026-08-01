const { SlashCommandBuilder } = require('discord.js');
const { pause, resume } = require('../lib/musicPlayer');
const { canUseMusic } = require('../lib/musicPermissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pause')
    .setDescription('Pause or resume the current song'),

  async execute(interaction) {
    if (!canUseMusic(interaction.member)) {
      return interaction.reply({ content: '❌ You need the VIP or Staff role to use music commands.', ephemeral: true });
    }
    const paused = pause(interaction.guildId);
    if (paused) return interaction.reply('⏸️ Paused.');
    const resumed = resume(interaction.guildId);
    if (resumed) return interaction.reply('▶️ Resumed.');
    await interaction.reply('❌ Nothing is playing.');
  }
};
