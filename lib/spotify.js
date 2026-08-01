const https = require('https');

let cachedToken = null;
let tokenExpiresAt = 0;

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('Failed to parse Spotify response')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Spotify credentials not configured');

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = 'grant_type=client_credentials';

  const { status, body: resp } = await httpsRequest({
    hostname: 'accounts.spotify.com',
    path: '/api/token',
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);

  if (status >= 400 || !resp.access_token) throw new Error(`Spotify auth failed: ${JSON.stringify(resp)}`);

  cachedToken = resp.access_token;
  tokenExpiresAt = Date.now() + (resp.expires_in - 60) * 1000;
  return cachedToken;
}

async function spotifyGet(path) {
  const token = await getToken();
  const { status, body } = await httpsRequest({
    hostname: 'api.spotify.com',
    path,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (status >= 400) throw new Error(`Spotify API error ${status}: ${JSON.stringify(body)}`);
  return body;
}

function trackToQuery(track) {
  const artists = track.artists.map(a => a.name).join(', ');
  return `${track.name} ${artists}`;
}

function trackToInfo(track) {
  return {
    spotifyQuery: trackToQuery(track),
    title: `${track.name} — ${track.artists.map(a => a.name).join(', ')}`,
    duration: track.duration_ms ? `${Math.floor(track.duration_ms / 60000)}:${String(Math.floor((track.duration_ms % 60000) / 1000)).padStart(2, '0')}` : '??:??',
    url: track.external_urls?.spotify || '',
  };
}

// Detect Spotify URL type and extract ID
function parseSpotifyUrl(url) {
  const match = url.match(/spotify\.com\/(track|playlist|album)\/([A-Za-z0-9]+)/);
  return match ? { type: match[1], id: match[2] } : null;
}

async function resolveSpotifyUrl(url) {
  const parsed = parseSpotifyUrl(url);
  if (!parsed) return null;

  if (parsed.type === 'track') {
    const track = await spotifyGet(`/v1/tracks/${parsed.id}`);
    return [trackToInfo(track)];
  }

  if (parsed.type === 'playlist') {
    const data = await spotifyGet(`/v1/playlists/${parsed.id}/tracks?limit=100`);
    return data.items
      .filter(i => i.track && i.track.type === 'track' && i.track.name && i.track.artists?.length)
      .map(i => {
        try { return trackToInfo(i.track); } catch { return null; }
      })
      .filter(Boolean);
  }

  if (parsed.type === 'album') {
    const data = await spotifyGet(`/v1/albums/${parsed.id}/tracks?limit=50`);
    const album = await spotifyGet(`/v1/albums/${parsed.id}`);
    return data.items.map(track => trackToInfo({ ...track, artists: track.artists.length ? track.artists : album.artists }));
  }

  return null;
}

async function searchSpotify(query, limit = 5) {
  const data = await spotifyGet(`/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`);
  return data.tracks.items.map(trackToInfo);
}

module.exports = { resolveSpotifyUrl, searchSpotify, parseSpotifyUrl };
