// Builds shared/countries.json (ISO 3166-1 alpha-2 codes + English names) from the ICU data inside Node.
const fs = require('fs');
const dn = new Intl.DisplayNames(['en'], { type: 'region' });
const skip = new Set(['AC','CP','DG','EA','EU','EZ','IC','TA','UN','XA','XB','ZZ','QO','AN','BU','CS','DD','FX','NT','SU','TP','YD','YU','ZR']);
const out = [];
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
  const c = String.fromCharCode(a, b);
  if (skip.has(c)) continue;
  let n; try { n = dn.of(c); } catch (e) { continue; }
  if (!n || n === c || /unknown|unassigned/i.test(n)) continue;
  out.push({ c, n });
}
out.sort((x, y) => x.n.localeCompare(y.n, 'en'));
fs.writeFileSync(__dirname + '/../shared/countries.json', JSON.stringify(out));
console.log(out.length, 'countries');
