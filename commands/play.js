const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { addToQueue, addManyToQueue, searchMultiple, shuffleQueue } = require('../lib/musicPlayer');
const { canUseMusic } = require('../lib/musicPermissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song in your voice channel')
    .addStringOption(o => o.setName('query').setDescription('Spotify/YouTube URL or search query').setRequired(true))
    .addBooleanOption(o => o.setName('shuffle').setDescription('Shuffle the playlist before queuing').setRequired(false)),

  async execute(interaction) {
    if (!canUseMusic(interaction.member)) {
      return interaction.reply({ content: '❌ You need the VIP or Staff role to use music commands.', ephemeral: true });
    }
    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: '❌ You need to be in a voice channel first.', ephemeral: true });
    }

    await interaction.deferReply();

    const query = interaction.options.getString('query');
    let results;
    try {
      results = await searchMultiple(query, 5);
    } catch (e) {
      return interaction.editReply(`❌ Search error: ${e.message}`);
    }

    // Direct URL — add all results (handles Spotify playlists/albums)
    if (/^https?:\/\//i.test(query)) {
      const doShuffle = interaction.options.getBoolean('shuffle');
      if (doShuffle && results.length > 1) {
        for (let i = results.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [results[i], results[j]] = [results[j], results[i]];
        }
      }
      await addManyToQueue(interaction.guildId, voiceChannel, interaction.channel, results);
      return interaction.deleteReply().catch(() => {});
    }

    // Single result — skip dropdown
    if (results.length === 1) {
      await addToQueue(interaction.guildId, voiceChannel, interaction.channel, results[0]);
      return interaction.deleteReply().catch(() => {});
    }

    const select = new StringSelectMenuBuilder()
      .setCustomId('play_song_select')
      .setPlaceholder('Choose a song to play')
      .addOptions(results.map((t, i) => ({
        label: t.title.length > 100 ? t.title.slice(0, 97) + '...' : t.title,
        description: t.duration,
        value: String(i),
      })));

    const row = new ActionRowBuilder().addComponents(select);
    const reply = await interaction.editReply({ content: '🔍 Select a song:', components: [row] });

    try {
      const selection = await reply.awaitMessageComponent({
        filter: i => i.user.id === interaction.user.id,
        time: 30_000,
      });
      await selection.deferUpdate();
      const track = results[parseInt(selection.values[0])];
      await addToQueue(interaction.guildId, voiceChannel, interaction.channel, track);
      await interaction.deleteReply().catch(() => {});
    } catch {
      await interaction.editReply({ content: '⏱️ Song selection timed out.', components: [] });
    }
  },
};
