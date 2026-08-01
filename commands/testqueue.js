const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { startQueue, toggleTestMode } = require('../lib/queue8');
const GAME_MAPS = require('../config/game_maps.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testqueue')
    .setDescription('Toggle test mode on the active queue, or start a new test queue')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('game').setDescription('Which game to draw maps from (only if no queue is active)').setRequired(false)
      .addChoices(...Object.entries(GAME_MAPS).map(([value, { label }]) => ({ name: label, value }))))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post the test queue in (only if no queue is active)').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const result = await toggleTestMode(interaction.channelId);

    if (result === 'toggled_on') {
      return interaction.editReply('🧪 Test mode **enabled** — click Join 8 times to fill the queue.');
    }
    if (result === 'toggled_off') {
      return interaction.editReply('✅ Test mode **disabled** — queue is back to normal.');
    }

    // No active queue — start a fresh test queue
    const game = interaction.options.getString('game') ?? 'bo6';
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    await startQueue(channel, true, game);
    await interaction.editReply(`🧪 **${GAME_MAPS[game].label}** test queue posted in ${channel}. Click Join 8 times to fill it.`);
  },
};
