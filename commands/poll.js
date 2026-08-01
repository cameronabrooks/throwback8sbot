const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create a poll')
    .addStringOption(o => o.setName('question').setDescription('The poll question').setRequired(true))
    .addStringOption(o => o.setName('option1').setDescription('Choice 1').setRequired(true))
    .addStringOption(o => o.setName('option2').setDescription('Choice 2').setRequired(true))
    .addStringOption(o => o.setName('option3').setDescription('Choice 3').setRequired(false))
    .addStringOption(o => o.setName('option4').setDescription('Choice 4').setRequired(false))
    .addStringOption(o => o.setName('option5').setDescription('Choice 5').setRequired(false))
    .addStringOption(o => o.setName('option6').setDescription('Choice 6').setRequired(false))
    .addIntegerOption(o => o.setName('duration').setDescription('How long the poll stays open (hours, default 24)').setMinValue(1).setMaxValue(168).setRequired(false))
    .addBooleanOption(o => o.setName('multi').setDescription('Allow multiple selections (default: no)').setRequired(false))
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post the poll in (default: current channel)').setRequired(false))
    .addBooleanOption(o => o.setName('ping').setDescription('Ping @everyone with the poll').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const question = interaction.options.getString('question');
    const duration = interaction.options.getInteger('duration') ?? 24;
    const multiselect = interaction.options.getBoolean('multi') ?? false;
    const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;
    const pingEveryone = interaction.options.getBoolean('ping') ?? false;

    const answers = ['option1', 'option2', 'option3', 'option4', 'option5', 'option6']
      .map(k => interaction.options.getString(k))
      .filter(Boolean)
      .map(text => ({ text }));

    try {
      await targetChannel.send({
        content: pingEveryone ? '@everyone' : undefined,
        allowedMentions: pingEveryone ? { parse: ['everyone'] } : { parse: [] },
        poll: {
          question: { text: question },
          answers,
          duration,
          allowMultiselect: multiselect,
        },
      });
      await interaction.editReply(`✅ Poll posted in ${targetChannel}.`);
    } catch (e) {
      await interaction.editReply(`❌ Failed to post poll: ${e.message}`);
    }
  },
};
