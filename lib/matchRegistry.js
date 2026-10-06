// Persists the Discord channel ids of in-flight 8s matches.
//
// Match state itself lives in memory, so a bot restart forgets every active match while its
// channels stay behind. Recording the ids on disk lets the bot clean up exactly those channels
// at startup (by id — never by guessing from channel names).
const fs = require('fs');
const path = require('path');

// Overridable so tests don't touch real data.
const REGISTRY_PATH = process.env.MATCH_REGISTRY_PATH || path.join(__dirname, '..', 'data', 'active_matches.json');

function all() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {}; // missing or corrupt file == nothing tracked
  }
}

function write(entries) {
  // Best effort: if this fails we only lose the restart cleanup, never the match itself.
  try {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    const tmp = `${REGISTRY_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
    fs.renameSync(tmp, REGISTRY_PATH);
  } catch { /* ignore */ }
}

// `key` identifies the match (its text channel id). Channel ids accumulate across calls.
function track(key, entry) {
  if (!key) return;
  const entries = all();
  const prev = entries[key] ?? {};
  entries[key] = {
    ...prev,
    ...entry,
    channelIds: [...new Set([...(prev.channelIds ?? []), ...(entry.channelIds ?? [])])],
  };
  write(entries);
}

function addChannels(key, channelIds) {
  if (!key) return;
  track(key, { channelIds });
}

function untrack(key) {
  if (!key) return;
  const entries = all();
  if (!(key in entries)) return;
  delete entries[key];
  write(entries);
}

module.exports = { all, track, addChannels, untrack, REGISTRY_PATH };
