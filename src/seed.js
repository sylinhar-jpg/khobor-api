'use strict';
const { CATEGORIES, DIVISIONS, CHANNELS, STORIES } = require('./seed-data');
const { classify } = require('./classify');

const SEED_VERSION = '1';

async function seed(db, { now = Date.now(), publicUrl = '' } = {}) {
  const done = await db.get("SELECT v FROM meta WHERE k = 'seed_version'");
  if (done && done.v === SEED_VERSION) return false;

  for (let i = 0; i < CATEGORIES.length; i++) {
    const [slug, name, nameEn] = CATEGORIES[i];
    const have = await db.get('SELECT id FROM categories WHERE slug = ?', [slug]);
    if (!have) await db.run('INSERT INTO categories (slug, name, name_en, sort) VALUES (?, ?, ?, ?)', [slug, name, nameEn, i]);
  }
  for (const [slug, name, desc, district, verified] of CHANNELS) {
    const have = await db.get('SELECT id FROM channels WHERE slug = ?', [slug]);
    if (!have) {
      await db.run(
        'INSERT INTO channels (slug, name, description, district, verified, is_sample, logo_url, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        [slug, name, desc, district, verified, `/static/channels/${slug}.png`, now]
      );
    }
  }
  const cats = Object.fromEntries((await db.all('SELECT id, slug FROM categories')).map((r) => [r.slug, r.id]));
  const chans = Object.fromEntries((await db.all('SELECT id, slug FROM channels')).map((r) => [r.slug, r.id]));
  for (let i = 0; i < STORIES.length; i++) {
    const [cat, chan, district, hoursAgo, featured, title, summary, paras] = STORIES[i];
    const guid = `sample:${i + 1}`;
    const have = await db.get('SELECT id FROM news WHERE guid = ?', [guid]);
    if (have) continue;
    const content = paras.join('\n\n');
    const c = classify(title, summary, content);
    await db.run(
      `INSERT INTO news (title, summary, content, image_url, category_id, channel_id, district, guid, published_at,
        status, is_featured, is_sample, haram_auto, haram_terms, views, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, 1, ?, ?, ?, ?)`,
      [title, summary, content, `/static/sample/${cat}-${(i % 3) + 1}.jpg`, cats[cat], chans[chan], district, guid,
        Math.round(now - hoursAgo * 3600e3), featured, c.is_haram ? 1 : 0, c.terms.join(','),
        Math.max(0, Math.round(400 / (1 + hoursAgo)) + ((i * 37) % 23)), now]
    );
  }
  if (done) await db.run("UPDATE meta SET v = ? WHERE k = 'seed_version'", [SEED_VERSION]);
  else await db.run("INSERT INTO meta (k, v) VALUES ('seed_version', ?)", [SEED_VERSION]);
  return true;
}

function districts() {
  const out = [];
  for (const [div, divBn, list] of DIVISIONS) {
    for (const [en, bn] of list) out.push({ id: en, name: bn, name_en: en, division: divBn, division_en: div });
  }
  return out;
}

module.exports = { seed, districts, SEED_VERSION };
