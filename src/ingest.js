'use strict';
// Optional RSS/Atom ingestion. Nothing runs until an admin adds a feed the operator has the right to republish
// (POST /api/admin/feeds). Only the headline, a short summary, the link and the image URL are stored; the full
// story stays on the publisher's site and the app links to it.
const { classify } = require('./classify');

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ').trim();
}
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}
function attr(xml, name, a) {
  const m = xml.match(new RegExp(`<${name}\\s[^>]*${a}="([^"]+)"`, 'i'));
  return m ? m[1] : '';
}

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 50)) {
    const title = decode(tag(b, 'title'));
    const link = decode(tag(b, 'link')) || attr(b, 'link', 'href');
    const guid = decode(tag(b, 'guid')) || decode(tag(b, 'id')) || link;
    const summary = decode(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 300);
    const date = Date.parse(decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated')));
    const image = attr(b, 'media:content', 'url') || attr(b, 'media:thumbnail', 'url') || attr(b, 'enclosure', 'url');
    if (title && guid) items.push({ title, link, guid, summary, date, image });
  }
  return items;
}

async function runFeeds(db, { fetchImpl = fetch, now = Date.now(), notifyFollowers } = {}) {
  const feeds = await db.all('SELECT * FROM feeds WHERE enabled = 1');
  let added = 0;
  for (const f of feeds) {
    try {
      const res = await fetchImpl(f.url, { headers: { 'User-Agent': 'KhoborBot/1.0' }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const items = parseFeed(await res.text());
      for (const it of items) {
        const guid = `feed:${f.id}:${it.guid}`.slice(0, 500);
        if (await db.get('SELECT id FROM news WHERE guid = ?', [guid])) continue;
        const c = classify(it.title, it.summary);
        const pub = Number.isFinite(it.date) ? Math.min(it.date, now) : now;
        const r = await db.run(`INSERT INTO news (title, summary, content, image_url, category_id, channel_id, source_url, guid, published_at,
          status, haram_auto, haram_terms, created_at) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?) RETURNING id`,
          [it.title.slice(0, 300), it.summary, /^https:\/\//.test(it.image) ? it.image : '', f.category_id, f.channel_id, it.link, guid, pub,
            c.is_haram ? 1 : 0, c.terms.join(','), now]);
        added++;
        if (notifyFollowers) await notifyFollowers(Number(r.rows[0].id), f.channel_id, it.title);
      }
      await db.run("UPDATE feeds SET last_run = ?, last_error = '' WHERE id = ?", [now, f.id]);
    } catch (e) {
      await db.run('UPDATE feeds SET last_run = ?, last_error = ? WHERE id = ?', [now, String(e.message).slice(0, 300), f.id]);
    }
  }
  return added;
}

module.exports = { parseFeed, runFeeds };
