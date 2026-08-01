const { Shoukaku, Connectors } = require('shoukaku');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { resolveSpotifyUrl, parseSpotifyUrl, searchSpotify } = require('./spotify');


const NODES = process.env.LAVALINK_HOST ? [{
  name: 'main',
  url: `${process.env.LAVALINK_HOST}:${process.env.LAVALINK_PORT || '2333'}`,
  auth: process.env.LAVALINK_PASSWORD || 'youshallnotpass',
  secure: (process.env.LAVALINK_SECURE || 'false') === 'true',
}] : [
  { name: 'jirayu', url: 'lavalink.jirayu.net:13592', auth: 'youshallnotpass', secure: false },
  { name: 'serenetia', url: 'lavalink.serenetia.com:443', auth: 'youshallnotpass', secure: true },
];

let shoukaku = null;
const guildStates = new Map();

function init(client) {
  shoukaku = new Shoukaku(new Connectors.DiscordJS(client), NODES, {
    moveOnDisconnect: false,
    resumable: false,
    reconnectTries: 5,
    reconnectInterval: 10000,
    restTimeout: 10000,
  });
  shoukaku.on('error', () => {});
}

const INACTIVITY_MS = 10 * 60 * 1000;

function getState(guildId) {
  if (!guildStates.has(guildId)) {
    guildStates.set(guildId, { queue: [], player: null, currentTrack: null, textChannel: null, inactivityTimer: null, trackStartedAt: null, retryCount: 0, nowPlayingMessage: null });
  }
  return guildStates.get(guildId);
}

function clearInactivityTimer(state) {
  if (state.inactivityTimer) { clearTimeout(state.inactivityTimer); state.inactivityTimer = null; }
}

function startInactivityTimer(guildId) {
  const state = getState(guildId);
  clearInactivityTimer(state);
  state.inactivityTimer = setTimeout(async () => {
    if (state.textChannel) state.textChannel.send('👋 Left the voice channel due to 10 minutes of inactivity.').catch(() => {});
    await stop(guildId);
  }, INACTIVITY_MS);
}

function formatDuration(ms) {
  if (!ms) return '??:??';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function trackToInfo(track) {
  return {
    encoded: track.encoded,
    title: track.info.title,
    duration: formatDuration(track.info.length),
    url: track.info.uri,
  };
}

async function resolveViaLavalink(spotifyQuery, fallbackTitle, fallbackDuration) {
  if (!shoukaku) throw new Error('Music player not initialized');
  const node = shoukaku.getIdealNode();
  if (!node) throw new Error('Music service is temporarily unavailable. Please try again in a moment.');
  const result = await node.rest.resolve(`ytsearch:${spotifyQuery}`);
  if (!result || result.loadType === 'empty' || result.loadType === 'error') throw new Error('No results found');
  const tracks = Array.isArray(result.data) ? result.data : [];
  if (!tracks.length) throw new Error('No results found');
  const t = tracks[0];
  return {
    encoded: t.encoded,
    title: fallbackTitle || t.info.title,
    duration: fallbackDuration || formatDuration(t.info.length),
    url: t.info.uri,
  };
}

async function searchMultiple(query, limit = 5) {
  if (!shoukaku) throw new Error('Music player not initialized');
  const node = shoukaku.getIdealNode();
  if (!node) throw new Error('Music service is temporarily unavailable. Please try again in a moment.');

  // Spotify URL — try Lavalink's native Spotify plugin first (most nodes have it),
  // then fall back to our Spotify API for metadata-only resolution
  if (/^https?:\/\/(open\.)?spotify\.com\//i.test(query)) {
    try {
      const result = await node.rest.resolve(query);
      if (result && result.loadType !== 'empty' && result.loadType !== 'error') {
        const tracks = Array.isArray(result.data) ? result.data
          : result.data?.tracks ? result.data.tracks
          : result.data ? [result.data] : [];
        if (tracks.length) return tracks.map(trackToInfo);
      }
    } catch {
      // Lavalink node doesn't have Spotify plugin — fall through to Spotify API
    }
    const spotifyTracks = await resolveSpotifyUrl(query);
    if (!spotifyTracks?.length) throw new Error('No results found');
    return spotifyTracks.map(t => ({ ...t, encoded: null }));
  }

  // Text search: try Spotify first, fall back to Lavalink/YouTube on any error
  if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
    try {
      const spotifyResults = await searchSpotify(query, limit);
      if (spotifyResults?.length) return spotifyResults.map(t => ({ ...t, encoded: null }));
    } catch {
      // Spotify search unavailable (e.g. 403) — fall through to Lavalink
    }
  }

  const result = await node.rest.resolve(`ytsearch:${query}`);
  if (!result || result.loadType === 'empty' || result.loadType === 'error') throw new Error('No results found');
  const tracks = Array.isArray(result.data) ? result.data : [];
  if (!tracks.length) throw new Error('No results found');
  return tracks.slice(0, limit).map(trackToInfo);
}

async function search(query) {
  const results = await searchMultiple(query, 1);
  return results[0];
}

async function playNext(guildId) {
  const state = getState(guildId);
  if (!state.queue.length) {
    state.currentTrack = null;
    startInactivityTimer(guildId);
    return;
  }
  clearInactivityTimer(state);
  const track = state.queue.shift();
  state.currentTrack = track;
  state.retryCount = 0;
  try {
    // Spotify tracks have no encoded value yet — resolve via Lavalink now
    if (!track.encoded) {
      const resolved = await resolveViaLavalink(track.spotifyQuery, track.title, track.duration);
      track.encoded = resolved.encoded;
    }
    state.trackStartedAt = Date.now();
    await state.player.playTrack({ track: { encoded: track.encoded } });
    if (state.textChannel) {
      const upcoming = state.queue.slice(0, 5);
      const embed = new EmbedBuilder()
        .setColor(0x1db954)
        .setTitle('🎵 Now Playing')
        .setDescription(`**${track.title}** (${track.duration})`)
        .addFields(
          upcoming.length
            ? { name: 'Up Next', value: upcoming.map((t, i) => `${i + 1}. ${t.title} (${t.duration})`).join('\n') }
            : { name: 'Up Next', value: 'Nothing — add more songs with /play' }
        );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('music_skip').setLabel('⏭ Skip').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_pause').setLabel('⏸ Pause').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_shuffle').setLabel('🔀 Shuffle').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('music_stop').setLabel('⏹ Stop').setStyle(ButtonStyle.Danger),
      );
      if (state.nowPlayingMessage) {
          state.nowPlayingMessage.edit({ embeds: [embed], components: [row] }).catch(() => {
            state.nowPlayingMessage = null;
          });
        } else {
          state.textChannel.send({ embeds: [embed], components: [row] })
            .then(msg => { state.nowPlayingMessage = msg; })
            .catch(() => {});
        }
    }
  } catch (e) {
    if (state.textChannel) {
      state.textChannel.send(`❌ Failed to play **${track.title}**: ${e.message}`).catch(() => {});
    }
    await playNext(guildId);
  }
}

async function addToQueue(guildId, voiceChannel, textChannel, trackInfo) {
  if (!shoukaku) throw new Error('Music player not initialized');
  const state = getState(guildId);
  state.textChannel = textChannel;

  if (!state.player) {
    state.player = await shoukaku.joinVoiceChannel({
      guildId,
      channelId: voiceChannel.id,
      shardId: voiceChannel.guild.shardId ?? 0,
      deaf: true,
    });

    state.player.on('end', (data) => {
      if (data?.reason === 'replaced') return;
      const elapsed = state.trackStartedAt ? Date.now() - state.trackStartedAt : Infinity;
      if (elapsed < 30000 && state.currentTrack && state.retryCount < 2) {
        state.retryCount++;
        state.queue.unshift(state.currentTrack);
      }
      playNext(guildId);
    });

    state.player.on('exception', () => {
      if (state.currentTrack && state.retryCount < 2) {
        state.retryCount++;
        state.queue.unshift(state.currentTrack);
      }
      playNext(guildId);
    });

    state.player.on('stuck', () => {
      if (state.currentTrack && state.retryCount < 2) {
        state.retryCount++;
        state.queue.unshift(state.currentTrack);
      }
      playNext(guildId);
    });
  }

  clearInactivityTimer(state);
  state.queue.push(trackInfo);
  if (!state.currentTrack) await playNext(guildId);
}

async function addManyToQueue(guildId, voiceChannel, textChannel, tracks) {
  if (!tracks.length) return;
  await addToQueue(guildId, voiceChannel, textChannel, tracks[0]);
  const state = getState(guildId);
  for (let i = 1; i < tracks.length; i++) state.queue.push(tracks[i]);
}

function skip(guildId) {
  const state = getState(guildId);
  if (!state.player) return false;
  state.trackStartedAt = null; // prevent retry logic from re-queuing the skipped track
  state.player.stopTrack();
  return true;
}

async function stop(guildId) {
  const state = guildStates.get(guildId);
  if (!state) return;
  clearInactivityTimer(state);
  state.queue = [];
  state.currentTrack = null;
  if (state.player) {
    await shoukaku.leaveVoiceChannel(guildId).catch(() => {});
    state.player = null;
  }
  state.nowPlayingMessage = null;
  guildStates.delete(guildId);
}

function pause(guildId) {
  const state = getState(guildId);
  if (!state.player) return false;
  state.player.setPaused(true);
  return true;
}

function resume(guildId) {
  const state = getState(guildId);
  if (!state.player) return false;
  state.player.setPaused(false);
  return true;
}

function getQueue(guildId) {
  const state = getState(guildId);
  return { current: state.currentTrack, queue: state.queue };
}

function shuffleQueue(guildId) {
  const state = getState(guildId);
  if (!state.queue.length) return false;
  for (let i = state.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
  }
  return true;
}

module.exports = { init, addToQueue, addManyToQueue, search, searchMultiple, skip, stop, pause, resume, getQueue, shuffleQueue };
