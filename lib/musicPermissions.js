// TODO: fill in for this server.
const MUSIC_ROLE_IDS = new Set([
  'SET_VIP_ROLE_ID',
  'SET_STAFF_ROLE_ID',
]);

function canUseMusic(member) {
  return member.roles.cache.some(r => MUSIC_ROLE_IDS.has(r.id));
}

module.exports = { canUseMusic };
