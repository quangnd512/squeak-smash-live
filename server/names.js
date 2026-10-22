// Player-name rules: 3-16 letters/digits/underscore, no impersonation, no obvious bad words.
const fs = require('fs');
const path = require('path');

const RESERVED = ['admin', 'administrator', 'moderator', 'mod', 'support', 'official', 'staff', 'squeak', 'squeaksmash', 'system', 'root', 'null', 'undefined'];

let blocked = [];
function loadBlocklist(file) {
  try {
    blocked = fs.readFileSync(file || path.join(__dirname, 'blocklist.txt'), 'utf8')
      .split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#'));
  } catch (e) { blocked = []; }
}
loadBlocklist();

// "f.u_c-k", "fuuuck", "ph0ck" style tricks
function squash(s) {
  return s.toLowerCase()
    .replace(/0/g, 'o').replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/[4@]/g, 'a').replace(/[5$]/g, 's').replace(/7/g, 't')
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1+/g, '$1');
}

function checkName(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'Please enter a name.' };
  const name = raw.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return { ok: false, error: 'Use 3 to 16 letters, numbers or underscores.' };
  if (/^[0-9_]+$/.test(name)) return { ok: false, error: 'Please include at least one letter.' };
  const key = name.toLowerCase();
  const sq = squash(name);
  if (RESERVED.some(r => sq === squash(r) || key === r)) return { ok: false, error: 'That name is not available. Try another one.' };
  if (blocked.some(w => sq.includes(squash(w)))) return { ok: false, error: 'Please choose a friendlier name.' };
  return { ok: true, name, key };
}

module.exports = { checkName, loadBlocklist };
