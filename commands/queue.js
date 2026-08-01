const { SlashCommandBuilder } = require('discord.js');
const { getQueue } = require('../lib/musicPlayer');
const { canUseMusic } = require('../lib/musicPermissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current music queue'),

  async execute(interaction) {
    if (!canUseMusic(interaction.member)) {
      return interaction.reply({ content: '❌ You need the VIP or Staff role to use music commands.', ephemeral: true });
    }
    const { current, queue } = getQueue(interaction.guildId);
    if (!current) return interaction.reply('Nothing is playing right now.');

    const lines = [`▶️ **Now playing:** ${current.title} (${current.duration})`];
    if (queue.length) {
      lines.push('', '**Up next:**');
      queue.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title} (${t.duration})`));
      if (queue.length > 10) lines.push(`...and ${queue.length - 10} more`);
    }
    await interaction.reply(lines.join('\n'));
  }
};
