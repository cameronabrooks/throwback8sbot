const { SlashCommandBuilder } = require('discord.js');
const { shuffleQueue } = require('../lib/musicPlayer');
const { canUseMusic } = require('../lib/musicPermissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('shuffle')
    .setDescription('Shuffle the current queue'),

  async execute(interaction) {
    if (!canUseMusic(interaction.member)) {
      return interaction.reply({ content: '❌ You need the VIP or Staff role to use music commands.', ephemeral: true });
    }
    const shuffled = shuffleQueue(interaction.guildId);
    await interaction.reply(shuffled ? '🔀 Queue shuffled.' : '❌ Nothing in the queue to shuffle.');
  },
};
