const { SlashCommandBuilder } = require('discord.js');
const { skip } = require('../lib/musicPlayer');
const { canUseMusic } = require('../lib/musicPermissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('skip')
    .setDescription('Skip the current song'),

  async execute(interaction) {
    if (!canUseMusic(interaction.member)) {
      return interaction.reply({ content: '❌ You need the VIP or Staff role to use music commands.', ephemeral: true });
    }
    const skipped = skip(interaction.guildId);
    await interaction.reply(skipped ? '⏭️ Skipped.' : '❌ Nothing is playing.');
  }
};
