'use strict';
// Khobor API. Plain node:http, JSON in and out. All routes live under /api.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classify, publicRules } = require('./classify');
const { districts } = require('./seed');

const PAGE = 20;
const MAX_UPLOAD = 5 * 1024 * 1024;
const STATIC_DIR = path.join(__dirname, '..', 'public');

function createApp(db, opts = {}) {
  const cfg = {
    otpEcho: opts.otpEcho ?? process.env.OTP_ECHO !== '0',
    adminToken: opts.adminToken ?? process.env.ADMIN_TOKEN ?? '',
    autoPublish: opts.autoPublish ?? process.env.AUTO_PUBLISH_POSTS !== '0',
    now: opts.now || (() => Date.now()),
  };
  const DISTRICTS = districts();
  const DISTRICT_IDS = new Set(DISTRICTS.map((d) => d.id));
  const limits = new Map();

  // ---------- helpers ----------
  class HttpError extends Error {
    constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
  }
  const bad = (code, msg) => new HttpError(400, code, msg);
  const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
  const scrypt = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
  const hashPin = (pin) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${scrypt(pin, salt)}`; };
  const checkPin = (pin, stored) => {
    const [salt, h] = String(stored).split(':');
    const a = Buffer.from(scrypt(pin, salt), 'hex');
    const b = Buffer.from(h || '', 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const str = (v, max, name) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw bad('invalid_' + name);
    const s = v.trim();
    if (s.length > max) throw bad('too_long_' + name);
    return s;
  };
  const intParam = (v, def, min, max) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  };
  function rate(key, max, windowMs) {
    const now = cfg.now();
    let e = limits.get(key);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; limits.set(key, e); }
    e.n++;
    if (limits.size > 50000) limits.clear();
    if (e.n > max) throw new HttpError(429, 'rate_limited', 'Too many requests, try again later');
  }
  function normIdentifier(raw) {
    const s = str(raw, 120, 'identifier').toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s;
    // Bengali digits -> ASCII, keep + and digits
    const d = s.replace(/[\u09e6-\u09ef]/g, (c) => String(c.charCodeAt(0) - 0x09e6)).replace(/[\s-]/g, '');
    let m = d.match(/^(?:\+?88)?(01[3-9]\d{8})$/);
    if (m) return '+88' + m[1];
    throw bad('invalid_identifier', 'Enter a Bangladeshi mobile number or an email address');
  }
  const validPin = (p) => typeof p === 'string' && /^\d{4,6}$/.test(p);

  async function userFromReq(req) {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/);
    if (!m) return null;
    const s = await db.get('SELECT user_id FROM sessions WHERE token_hash = ?', [sha(m[1])]);
    if (!s) return null;
    return db.get('SELECT * FROM users WHERE id = ?', [s.user_id]);
  }
  async function needUser(req) {
    const u = await userFromReq(req);
    if (!u) throw new HttpError(401, 'login_required', 'Please log in');
    return u;
  }
  function needAdmin(req) {
    const h = req.headers.authorization || '';
    if (!cfg.adminToken || h !== `Bearer ${cfg.adminToken}`) throw new HttpError(401, 'admin_required');
  }
  async function newSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    await db.run('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)', [sha(token), userId, cfg.now()]);
    return token;
  }
  function publicUser(u, self = false) {
    if (!u) return null;
    const o = { id: u.id, name: u.name, username: u.username || '', bio: u.bio, district: u.district, photo_url: u.photo_url };
    if (self) { o.identifier = u.identifier; o.created_at = u.created_at; }
    return o;
  }

  const NEWS_SELECT = `SELECT n.*, c.slug AS category_slug, c.name AS category_name, ch.name AS channel_name,
      ch.slug AS channel_slug, ch.logo_url AS channel_logo, ch.verified AS channel_verified, u.name AS author_name,
      (SELECT COUNT(*) FROM news_likes l WHERE l.news_id = n.id) AS like_count,
      (SELECT COUNT(*) FROM comments m WHERE m.news_id = n.id) AS comment_count
    FROM news n LEFT JOIN categories c ON c.id = n.category_id LEFT JOIN channels ch ON ch.id = n.channel_id
    LEFT JOIN users u ON u.id = n.author_user_id`;
  const isHaram = (n) => (n.haram_override === null || n.haram_override === undefined ? !!n.haram_auto || !!n.author_marked_haram : !!n.haram_override);
  function haramReason(n) {
    if (n.haram_override !== null && n.haram_override !== undefined) return 'editor';
    if (n.author_marked_haram) return 'author';
    if (n.haram_auto) return 'keywords';
    return '';
  }
  function newsCard(n, full = false) {
    const o = {
      id: n.id, title: n.title, summary: n.summary, image_url: n.image_url,
      category: n.category_slug || '', category_name: n.category_name || '',
      channel_id: n.channel_id, channel_name: n.channel_name || n.author_name || '', channel_logo: n.channel_logo || '',
      channel_verified: !!n.channel_verified, district: n.district,
      published_at: new Date(Number(n.published_at)).toISOString(), is_sample: !!n.is_sample,
      is_haram: isHaram(n), views: Number(n.views), like_count: Number(n.like_count || 0), comment_count: Number(n.comment_count || 0),
      is_featured: !!n.is_featured, is_community: !!n.author_user_id,
    };
    if (full) {
      o.content = n.content;
      o.source_url = n.source_url;
      o.haram_reason = haramReason(n);
      o.haram_terms = n.haram_terms ? n.haram_terms.split(',').filter(Boolean) : [];
      o.author_name = n.author_name || '';
      o.status = n.status;
    }
    return o;
  }

  async function notify(userId, kind, title, body, newsId, actorName) {
    await db.run('INSERT INTO notifications (user_id, kind, title, body, news_id, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, kind, title, body || '', newsId || null, actorName || '', cfg.now()]);
  }
  async function notifyFollowers(newsId, channelId, title) {
    if (!channelId) return;
    const ch = await db.get('SELECT name FROM channels WHERE id = ?', [channelId]);
    const f = await db.all('SELECT user_id FROM follows WHERE channel_id = ? AND alerts = 1', [channelId]);
    for (const r of f) await notify(r.user_id, 'channel_post', ch ? ch.name : '', title, newsId, ch ? ch.name : '');
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/health', async () => ({ ok: true, db: db.kind }));

  route('GET', '/api/config', async () => ({
    name: 'Khobor', otp_demo: cfg.otpEcho, sample_notice: 'Stories marked নমুনা are sample content for testing.',
    halal: publicRules(),
  }));
  route('GET', '/api/halal/rules', async () => publicRules());

  route('GET', '/api/categories', async () => {
    const rows = await db.all(`SELECT c.id, c.slug, c.name, c.name_en,
      (SELECT COUNT(*) FROM news n WHERE n.category_id = c.id AND n.status = 'published') AS count
      FROM categories c ORDER BY c.sort, c.id`);
    return { categories: rows.map((r) => ({ ...r, count: Number(r.count) })) };
  });

  route('GET', '/api/districts', async () => ({ districts: DISTRICTS }));

  async function feed(q, user) {
    const where = ["n.status = 'published'", 'n.published_at <= ?'];
    const p = [cfg.now()];
    if (q.category) { where.push('c.slug = ?'); p.push(String(q.category)); }
    if (q.channel) { where.push('n.channel_id = ?'); p.push(intParam(q.channel, 0, 0, 1e12)); }
    if (q.district) { where.push('n.district = ?'); p.push(String(q.district)); }
    if (q.following === '1') {
      if (!user) throw new HttpError(401, 'login_required');
      where.push('n.channel_id IN (SELECT channel_id FROM follows WHERE user_id = ?)'); p.push(user.id);
    }
    if (q.q) {
      const term = String(q.q).trim().slice(0, 80);
      if (term) {
        where.push('(LOWER(n.title) LIKE ? OR LOWER(n.summary) LIKE ? OR LOWER(n.content) LIKE ?)');
        const like = '%' + term.toLowerCase().replace(/[%_]/g, '') + '%';
        p.push(like, like, like);
      }
    }
    if (q.halal === 'hide') {
      where.push(`NOT (CASE WHEN n.haram_override IS NULL THEN (n.haram_auto = 1 OR n.author_marked_haram = 1) ELSE n.haram_override = 1 END)`);
    }
    if (q.before) {
      const [ts, id] = String(q.before).split('_').map(Number);
      if (Number.isFinite(ts) && Number.isFinite(id)) {
        where.push('(n.published_at < ? OR (n.published_at = ? AND n.id < ?))'); p.push(ts, ts, id);
      }
    }
    const limit = intParam(q.limit, PAGE, 1, 50);
    const rows = await db.all(`${NEWS_SELECT} WHERE ${where.join(' AND ')} ORDER BY n.published_at DESC, n.id DESC LIMIT ${limit + 1}`, p);
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items: items.map((n) => newsCard(n)), next: more && last ? `${last.published_at}_${last.id}` : null };
  }
  route('GET', '/api/feed', async (req, q) => feed(q, await userFromReq(req)));

  route('GET', '/api/trending', async (req, q) => {
    // Most-read stories of the last 7 days (same window the reference app shows), max 8.
    const since = cfg.now() - 7 * 86400e3;
    const extra = q.halal === 'hide'
      ? ` AND NOT (CASE WHEN n.haram_override IS NULL THEN (n.haram_auto = 1 OR n.author_marked_haram = 1) ELSE n.haram_override = 1 END)` : '';
    const rows = await db.all(`${NEWS_SELECT} WHERE n.status = 'published' AND n.published_at >= ? AND n.published_at <= ? AND n.views > 0${extra}
      ORDER BY n.views DESC, n.published_at DESC LIMIT 8`, [since, cfg.now()]);
    return { items: rows.map((n) => newsCard(n)) };
  });

  async function getNews(id, user) {
    const n = await db.get(`${NEWS_SELECT} WHERE n.id = ?`, [id]);
    if (!n) throw new HttpError(404, 'not_found');
    if (n.status !== 'published' && !(user && n.author_user_id === user.id)) throw new HttpError(404, 'not_found');
    return n;
  }
  route('GET', '/api/news/:id', async (req, q, { id }) => {
    const user = await userFromReq(req);
    const n = await getNews(intParam(id, 0, 0, 1e12), user);
    const card = newsCard(n, true);
    if (user) {
      card.liked = !!(await db.get('SELECT 1 AS x FROM news_likes WHERE user_id = ? AND news_id = ?', [user.id, n.id]));
      card.bookmarked = !!(await db.get('SELECT 1 AS x FROM bookmarks WHERE user_id = ? AND news_id = ?', [user.id, n.id]));
      card.following = n.channel_id ? !!(await db.get('SELECT 1 AS x FROM follows WHERE user_id = ? AND channel_id = ?', [user.id, n.channel_id])) : false;
    }
    const rel = await db.all(`${NEWS_SELECT} WHERE n.status = 'published' AND n.id <> ? AND n.category_id = ? AND n.published_at <= ?
      ORDER BY n.published_at DESC LIMIT 4`, [n.id, n.category_id, cfg.now()]);
    card.related = rel.map((r) => newsCard(r));
    return card;
  });
  route('POST', '/api/news/:id/view', async (req, q, { id }) => {
    const nid = intParam(id, 0, 0, 1e12);
    const ip = req.socket.remoteAddress || '';
    try { rate(`view:${ip}:${nid}`, 1, 30 * 60e3); } catch { return { counted: false }; }
    const r = await db.run("UPDATE news SET views = views + 1 WHERE id = ? AND status = 'published'", [nid]);
    return { counted: r.changes > 0 };
  });
  async function toggle(table, col, user, id, on) {
    const have = await db.get(`SELECT 1 AS x FROM ${table} WHERE user_id = ? AND ${col} = ?`, [user.id, id]);
    const want = on === undefined ? !have : !!on;
    if (want && !have) await db.run(`INSERT INTO ${table} (user_id, ${col}, created_at) VALUES (?, ?, ?)`, [user.id, id, cfg.now()]);
    if (!want && have) await db.run(`DELETE FROM ${table} WHERE user_id = ? AND ${col} = ?`, [user.id, id]);
    return want;
  }
  route('POST', '/api/news/:id/like', async (req, q, { id }, body) => {
    const user = await needUser(req);
    const n = await getNews(intParam(id, 0, 0, 1e12), user);
    const liked = await toggle('news_likes', 'news_id', user, n.id, body.on);
    const c = await db.get('SELECT COUNT(*) AS c FROM news_likes WHERE news_id = ?', [n.id]);
    return { liked, like_count: Number(c.c) };
  });
  route('POST', '/api/news/:id/bookmark', async (req, q, { id }, body) => {
    const user = await needUser(req);
    const n = await getNews(intParam(id, 0, 0, 1e12), user);
    return { bookmarked: await toggle('bookmarks', 'news_id', user, n.id, body.on) };
  });
  route('GET', '/api/bookmarks', async (req) => {
    const user = await needUser(req);
    const rows = await db.all(`${NEWS_SELECT} JOIN bookmarks b ON b.news_id = n.id WHERE b.user_id = ? AND n.status = 'published'
      ORDER BY b.created_at DESC LIMIT 200`, [user.id]);
    return { items: rows.map((n) => newsCard(n)) };
  });

  // ---------- comments ----------
  route('GET', '/api/news/:id/comments', async (req, q, { id }) => {
    const user = await userFromReq(req);
    const nid = intParam(id, 0, 0, 1e12);
    const rows = await db.all(`SELECT m.*, u.name, u.photo_url, u.username,
      (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = m.id) AS likes
      ${user ? ', (SELECT COUNT(*) FROM comment_likes cl2 WHERE cl2.comment_id = m.id AND cl2.user_id = ?) AS mine' : ''}
      FROM comments m JOIN users u ON u.id = m.user_id WHERE m.news_id = ? ORDER BY m.created_at ASC LIMIT 500`,
      user ? [user.id, nid] : [nid]);
    const map = new Map();
    const top = [];
    for (const r of rows) {
      const c = {
        id: r.id, parent_id: r.parent_id, body: r.body, anonymous: !!r.anonymous,
        author: r.anonymous ? 'বেনামী পাঠক' : r.name, photo_url: r.anonymous ? '' : r.photo_url,
        created_at: new Date(Number(r.created_at)).toISOString(), likes: Number(r.likes), liked: !!Number(r.mine || 0),
        mine: !!(user && user.id === r.user_id), replies: [],
      };
      map.set(c.id, c);
      if (c.parent_id && map.has(c.parent_id)) map.get(c.parent_id).replies.push(c);
      else top.push(c);
    }
    return { comments: top.reverse(), count: rows.length };
  });
  route('POST', '/api/news/:id/comments', async (req, q, { id }, body) => {
    const user = await needUser(req);
    rate(`comment:${user.id}`, 20, 10 * 60e3);
    const n = await getNews(intParam(id, 0, 0, 1e12), user);
    const text = str(body.body, 1000, 'body');
    if (!text) throw bad('empty_comment');
    let parent = null;
    if (body.parent_id) {
      parent = await db.get('SELECT * FROM comments WHERE id = ? AND news_id = ?', [intParam(body.parent_id, 0, 0, 1e12), n.id]);
      if (!parent) throw bad('invalid_parent');
      if (parent.parent_id) parent = await db.get('SELECT * FROM comments WHERE id = ?', [parent.parent_id]);
    }
    const r = await db.run('INSERT INTO comments (news_id, user_id, parent_id, body, anonymous, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      [n.id, user.id, parent ? parent.id : null, text, body.anonymous ? 1 : 0, cfg.now()]);
    if (parent && parent.user_id !== user.id) {
      await notify(parent.user_id, 'reply', body.anonymous ? 'বেনামী পাঠক' : user.name, text.slice(0, 140), n.id, body.anonymous ? '' : user.name);
    }
    return { id: Number(r.rows[0].id) };
  });
  route('POST', '/api/comments/:id/like', async (req, q, { id }) => {
    const user = await needUser(req);
    const c = await db.get('SELECT * FROM comments WHERE id = ?', [intParam(id, 0, 0, 1e12)]);
    if (!c) throw new HttpError(404, 'not_found');
    const have = await db.get('SELECT 1 AS x FROM comment_likes WHERE user_id = ? AND comment_id = ?', [user.id, c.id]);
    if (have) await db.run('DELETE FROM comment_likes WHERE user_id = ? AND comment_id = ?', [user.id, c.id]);
    else {
      await db.run('INSERT INTO comment_likes (user_id, comment_id) VALUES (?, ?)', [user.id, c.id]);
      if (c.user_id !== user.id) await notify(c.user_id, 'comment_like', user.name, c.body.slice(0, 140), c.news_id, user.name);
    }
    const n = await db.get('SELECT COUNT(*) AS c FROM comment_likes WHERE comment_id = ?', [c.id]);
    return { liked: !have, likes: Number(n.c) };
  });
  route('DELETE', '/api/comments/:id', async (req, q, { id }) => {
    const user = await needUser(req);
    const c = await db.get('SELECT * FROM comments WHERE id = ?', [intParam(id, 0, 0, 1e12)]);
    if (!c || c.user_id !== user.id) throw new HttpError(404, 'not_found');
    await db.run('DELETE FROM comment_likes WHERE comment_id IN (SELECT id FROM comments WHERE id = ? OR parent_id = ?)', [c.id, c.id]);
    await db.run('DELETE FROM comments WHERE id = ? OR parent_id = ?', [c.id, c.id]);
    return { deleted: true };
  });

  // ---------- channels ----------
  const CHANNEL_SELECT = `SELECT ch.*, (SELECT COUNT(*) FROM follows f WHERE f.channel_id = ch.id) AS followers,
    (SELECT COUNT(*) FROM news n WHERE n.channel_id = ch.id AND n.status = 'published') AS posts FROM channels ch`;
  function channelOut(c) {
    return { id: c.id, name: c.name, description: c.description, website: c.website, district: c.district, logo_url: c.logo_url,
      verified: !!c.verified, is_sample: !!c.is_sample, followers: Number(c.followers || 0), posts: Number(c.posts || 0),
      following: c.following === undefined ? undefined : !!Number(c.following) };
  }
  route('GET', '/api/channels', async (req, q) => {
    const user = await userFromReq(req);
    const p = [];
    let where = '1=1';
    if (q.q) { where = '(LOWER(ch.name) LIKE ? OR LOWER(ch.description) LIKE ?)'; const l = '%' + String(q.q).toLowerCase().slice(0, 60) + '%'; p.push(l, l); }
    const rows = await db.all(`SELECT * FROM (${CHANNEL_SELECT}) ch WHERE ${where} ORDER BY ch.verified DESC, ch.followers DESC, ch.name LIMIT 200`, p);
    let followed = new Set();
    if (user) followed = new Set((await db.all('SELECT channel_id FROM follows WHERE user_id = ?', [user.id])).map((r) => Number(r.channel_id)));
    return { channels: rows.map((r) => channelOut({ ...r, following: user ? followed.has(Number(r.id)) : undefined })) };
  });
  route('GET', '/api/channels/:id', async (req, q, { id }) => {
    const user = await userFromReq(req);
    const c = await db.get(`SELECT * FROM (${CHANNEL_SELECT}) ch WHERE ch.id = ?`, [intParam(id, 0, 0, 1e12)]);
    if (!c) throw new HttpError(404, 'not_found');
    if (user) {
      const f = await db.get('SELECT alerts FROM follows WHERE user_id = ? AND channel_id = ?', [user.id, c.id]);
      c.following = f ? 1 : 0; c.alerts = f ? !!f.alerts : false;
    }
    return { ...channelOut(c), alerts: c.alerts };
  });
  route('POST', '/api/channels/:id/follow', async (req, q, { id }, body) => {
    const user = await needUser(req);
    const c = await db.get('SELECT id FROM channels WHERE id = ?', [intParam(id, 0, 0, 1e12)]);
    if (!c) throw new HttpError(404, 'not_found');
    const following = await toggle('follows', 'channel_id', user, c.id, body.on);
    if (following && body.alerts !== undefined) await db.run('UPDATE follows SET alerts = ? WHERE user_id = ? AND channel_id = ?', [body.alerts ? 1 : 0, user.id, c.id]);
    const n = await db.get('SELECT COUNT(*) AS c FROM follows WHERE channel_id = ?', [c.id]);
    return { following, followers: Number(n.c) };
  });
  route('POST', '/api/channels/:id/alerts', async (req, q, { id }, body) => {
    const user = await needUser(req);
    const r = await db.run('UPDATE follows SET alerts = ? WHERE user_id = ? AND channel_id = ?', [body.on ? 1 : 0, user.id, intParam(id, 0, 0, 1e12)]);
    if (!r.changes) throw bad('not_following');
    return { alerts: !!body.on };
  });
  route('GET', '/api/following', async (req) => {
    const user = await needUser(req);
    const rows = await db.all(`SELECT ch.*, f.alerts, 1 AS following FROM (${CHANNEL_SELECT}) ch JOIN follows f ON f.channel_id = ch.id
      WHERE f.user_id = ? ORDER BY f.created_at DESC`, [user.id]);
    return { channels: rows.map((r) => ({ ...channelOut(r), alerts: !!r.alerts })) };
  });

  route('GET', '/api/search', async (req, q) => {
    const term = String(q.q || '').trim();
    if (!term) return { news: [], channels: [] };
    const user = await userFromReq(req);
    const news = await feed({ q: term, limit: q.limit || 30, halal: q.halal }, user);
    const l = '%' + term.toLowerCase().slice(0, 60) + '%';
    const ch = await db.all(`SELECT * FROM (${CHANNEL_SELECT}) ch WHERE LOWER(ch.name) LIKE ? OR LOWER(ch.description) LIKE ? ORDER BY ch.followers DESC LIMIT 10`, [l, l]);
    return { news: news.items, channels: ch.map(channelOut) };
  });

  // ---------- auth ----------
  // Lets the login screen decide between the PIN step (existing account) and sign-up (new account).
  route('POST', '/api/auth/check', async (req, q, p, body) => {
    rate(`checkip:${req.socket.remoteAddress}`, 60, 15 * 60e3);
    const identifier = normIdentifier(body.identifier);
    const u = await db.get('SELECT id FROM users WHERE identifier = ?', [identifier]);
    return { identifier, exists: !!u };
  });
  route('POST', '/api/auth/otp', async (req, q, p, body) => {
    const identifier = normIdentifier(body.identifier);
    const purpose = body.purpose === 'reset' ? 'reset' : 'register';
    rate(`otp:${identifier}`, 5, 60 * 60e3);
    rate(`otpip:${req.socket.remoteAddress}`, 30, 60 * 60e3);
    const exists = await db.get('SELECT id FROM users WHERE identifier = ?', [identifier]);
    if (purpose === 'register' && exists) throw new HttpError(409, 'already_registered', 'This number or email already has an account');
    if (purpose === 'reset' && !exists) throw new HttpError(404, 'no_account', 'No account with this number or email');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.run('UPDATE otps SET used = 1 WHERE identifier = ? AND purpose = ? AND used = 0', [identifier, purpose]);
    await db.run('INSERT INTO otps (identifier, purpose, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      [identifier, purpose, sha(identifier + ':' + code), cfg.now() + 10 * 60e3, cfg.now()]);
    const out = { sent: true, identifier, expires_in: 600 };
    // No SMS or email provider is connected. In demo mode the code is returned so the app can show it.
    if (cfg.otpEcho) out.demo_code = code;
    else console.log(`[otp] ${purpose} code for ${identifier.replace(/.(?=.{3})/g, '*')} generated (delivery provider not configured)`);
    return out;
  });
  route('POST', '/api/auth/otp/verify', async (req, q, p, body) => {
    const identifier = normIdentifier(body.identifier);
    const purpose = body.purpose === 'reset' ? 'reset' : 'register';
    const code = str(body.code, 10, 'code').replace(/[\u09e6-\u09ef]/g, (c) => String(c.charCodeAt(0) - 0x09e6));
    const o = await db.get('SELECT * FROM otps WHERE identifier = ? AND purpose = ? AND used = 0 ORDER BY id DESC LIMIT 1', [identifier, purpose]);
    if (!o || o.expires_at < cfg.now()) throw bad('otp_expired', 'The code has expired, request a new one');
    if (o.attempts >= 5) throw bad('otp_locked', 'Too many wrong codes, request a new one');
    if (sha(identifier + ':' + code) !== o.code_hash) {
      await db.run('UPDATE otps SET attempts = attempts + 1 WHERE id = ?', [o.id]);
      throw bad('otp_wrong', 'Wrong code');
    }
    const vt = crypto.randomBytes(24).toString('base64url');
    await db.run('UPDATE otps SET verify_token_hash = ?, attempts = 99 WHERE id = ?', [sha(vt), o.id]);
    return { verify_token: vt };
  });
  async function consumeVerify(token, purpose) {
    if (typeof token !== 'string' || token.length < 20) throw bad('invalid_verify_token');
    const o = await db.get('SELECT * FROM otps WHERE verify_token_hash = ? AND purpose = ? AND used = 0', [sha(token), purpose]);
    if (!o || o.expires_at + 20 * 60e3 < cfg.now()) throw bad('invalid_verify_token', 'Verification expired, start again');
    await db.run('UPDATE otps SET used = 1 WHERE id = ?', [o.id]);
    return o.identifier;
  }
  route('POST', '/api/auth/register', async (req, q, p, body) => {
    const name = str(body.name, 60, 'name');
    if (name.length < 2) throw bad('invalid_name', 'Enter your name');
    if (!validPin(body.pin)) throw bad('invalid_pin', 'PIN must be 4 to 6 digits');
    const identifier = await consumeVerify(body.verify_token, 'register');
    if (await db.get('SELECT id FROM users WHERE identifier = ?', [identifier])) throw new HttpError(409, 'already_registered');
    const r = await db.run('INSERT INTO users (identifier, name, pin_hash, district, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [identifier, name, hashPin(body.pin), DISTRICT_IDS.has(body.district) ? body.district : '', cfg.now()]);
    const id = Number(r.rows[0].id);
    const token = await newSession(id);
    return { token, user: publicUser(await db.get('SELECT * FROM users WHERE id = ?', [id]), true) };
  });
  route('POST', '/api/auth/login', async (req, q, p, body) => {
    const identifier = normIdentifier(body.identifier);
    rate(`loginip:${req.socket.remoteAddress}`, 30, 15 * 60e3);
    const u = await db.get('SELECT * FROM users WHERE identifier = ?', [identifier]);
    if (!u) throw new HttpError(401, 'wrong_login', 'Wrong number/email or PIN');
    if (u.locked_until > cfg.now()) throw new HttpError(429, 'locked', 'Too many wrong PINs. Try again in 15 minutes or reset your PIN.');
    if (typeof body.pin !== 'string' || !checkPin(body.pin, u.pin_hash)) {
      const fails = u.failed_pins + 1;
      await db.run('UPDATE users SET failed_pins = ?, locked_until = ? WHERE id = ?', [fails >= 5 ? 0 : fails, fails >= 5 ? cfg.now() + 15 * 60e3 : 0, u.id]);
      throw new HttpError(401, 'wrong_login', 'Wrong number/email or PIN');
    }
    await db.run('UPDATE users SET failed_pins = 0, locked_until = 0 WHERE id = ?', [u.id]);
    return { token: await newSession(u.id), user: publicUser(u, true) };
  });
  route('POST', '/api/auth/reset-pin', async (req, q, p, body) => {
    if (!validPin(body.pin)) throw bad('invalid_pin', 'PIN must be 4 to 6 digits');
    const identifier = await consumeVerify(body.verify_token, 'reset');
    const u = await db.get('SELECT id FROM users WHERE identifier = ?', [identifier]);
    if (!u) throw new HttpError(404, 'no_account');
    await db.run('UPDATE users SET pin_hash = ?, failed_pins = 0, locked_until = 0 WHERE id = ?', [hashPin(body.pin), u.id]);
    await db.run('DELETE FROM sessions WHERE user_id = ?', [u.id]);
    return { token: await newSession(u.id) };
  });
  route('POST', '/api/auth/logout', async (req) => {
    const m = (req.headers.authorization || '').match(/^Bearer\s+(\S+)$/);
    if (m) await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha(m[1])]);
    return { ok: true };
  });

  // ---------- me ----------
  route('GET', '/api/me', async (req) => {
    const u = await needUser(req);
    const counts = await db.get(`SELECT (SELECT COUNT(*) FROM follows WHERE user_id = ?) AS following,
      (SELECT COUNT(*) FROM bookmarks WHERE user_id = ?) AS bookmarks,
      (SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read = 0) AS unread,
      (SELECT COUNT(*) FROM news WHERE author_user_id = ? AND status <> 'draft') AS posts`, [u.id, u.id, u.id, u.id]);
    return { user: publicUser(u, true), counts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)])) };
  });
  route('PATCH', '/api/me', async (req, q, p, body) => {
    const u = await needUser(req);
    const sets = [];
    const vals = [];
    if (body.name !== undefined) { const n = str(body.name, 60, 'name'); if (n.length < 2) throw bad('invalid_name'); sets.push('name = ?'); vals.push(n); }
    if (body.bio !== undefined) { sets.push('bio = ?'); vals.push(str(body.bio, 200, 'bio')); }
    if (body.district !== undefined) {
      if (body.district && !DISTRICT_IDS.has(body.district)) throw bad('invalid_district');
      sets.push('district = ?'); vals.push(body.district || '');
    }
    if (body.username !== undefined) {
      const un = str(body.username, 30, 'username').toLowerCase();
      if (un && !/^[a-z0-9_.]{3,30}$/.test(un)) throw bad('invalid_username', 'Use 3-30 letters, numbers, _ or .');
      if (un) {
        const t = await db.get('SELECT id FROM users WHERE username = ? AND id <> ?', [un, u.id]);
        if (t) throw new HttpError(409, 'username_taken', 'That username is taken');
      }
      sets.push('username = ?'); vals.push(un || null);
    }
    if (body.photo_url !== undefined) {
      const pu = str(body.photo_url, 200, 'photo_url');
      if (pu && !/^\/u\/[a-f0-9]{32}$/.test(pu)) throw bad('invalid_photo');
      sets.push('photo_url = ?'); vals.push(pu);
    }
    if (body.pin !== undefined) {
      if (!validPin(body.pin)) throw bad('invalid_pin');
      if (typeof body.old_pin !== 'string' || !checkPin(body.old_pin, u.pin_hash)) throw new HttpError(401, 'wrong_pin', 'Current PIN is wrong');
      sets.push('pin_hash = ?'); vals.push(hashPin(body.pin));
    }
    if (sets.length) await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...vals, u.id]);
    return { user: publicUser(await db.get('SELECT * FROM users WHERE id = ?', [u.id]), true) };
  });
  route('GET', '/api/username-available', async (req, q) => {
    const un = String(q.u || '').toLowerCase();
    if (!/^[a-z0-9_.]{3,30}$/.test(un)) return { available: false, reason: 'invalid' };
    const t = await db.get('SELECT id FROM users WHERE username = ?', [un]);
    return { available: !t };
  });
  route('DELETE', '/api/me', async (req, q, p, body) => {
    const u = await needUser(req);
    if (typeof body.pin !== 'string' || !checkPin(body.pin, u.pin_hash)) throw new HttpError(401, 'wrong_pin', 'PIN is wrong');
    for (const [t, c] of [['sessions', 'user_id'], ['news_likes', 'user_id'], ['bookmarks', 'user_id'], ['follows', 'user_id'],
      ['comment_likes', 'user_id'], ['notifications', 'user_id'], ['uploads', 'user_id'], ['suggestions', 'user_id']]) {
      await db.run(`DELETE FROM ${t} WHERE ${c} = ?`, [u.id]);
    }
    await db.run('DELETE FROM comments WHERE user_id = ?', [u.id]);
    await db.run('DELETE FROM news WHERE author_user_id = ?', [u.id]);
    await db.run('DELETE FROM users WHERE id = ?', [u.id]);
    return { deleted: true };
  });

  // ---------- notifications ----------
  route('GET', '/api/notifications', async (req, q) => {
    const u = await needUser(req);
    const rows = await db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', [u.id]);
    const unread = rows.filter((r) => !r.read).length;
    return { unread, items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, news_id: r.news_id, read: !!r.read,
      created_at: new Date(Number(r.created_at)).toISOString() })) };
  });
  route('GET', '/api/notifications/unread', async (req, q) => {
    const u = await needUser(req);
    const since = intParam(q.since, 0, 0, 9e15);
    const c = await db.get('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0', [u.id]);
    const fresh = await db.all('SELECT id, kind, title, body, news_id, created_at FROM notifications WHERE user_id = ? AND read = 0 AND id > ? ORDER BY id DESC LIMIT 5', [u.id, since]);
    return { unread: Number(c.c), fresh: fresh.map((r) => ({ ...r, created_at: new Date(Number(r.created_at)).toISOString() })) };
  });
  route('POST', '/api/notifications/read', async (req, q, p, body) => {
    const u = await needUser(req);
    if (body.id) await db.run('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?', [u.id, intParam(body.id, 0, 0, 1e12)]);
    else await db.run('UPDATE notifications SET read = 1 WHERE user_id = ?', [u.id]);
    return { ok: true };
  });

  // ---------- uploads ----------
  route('POST', '/api/uploads', async (req, q, p, body, raw) => {
    const u = await needUser(req);
    rate(`upload:${u.id}`, 30, 60 * 60e3);
    const buf = raw || Buffer.alloc(0);
    if (!buf.length) throw bad('empty_upload');
    const sig = buf.subarray(0, 12).toString('hex');
    let mime = '';
    if (sig.startsWith('ffd8ff')) mime = 'image/jpeg';
    else if (sig.startsWith('89504e470d0a1a0a')) mime = 'image/png';
    else if (sig.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
    if (!mime) throw bad('not_an_image', 'Only JPEG, PNG or WebP photos');
    const id = crypto.randomBytes(16).toString('hex');
    await db.run('INSERT INTO uploads (id, user_id, mime, data, created_at) VALUES (?, ?, ?, ?, ?)', [id, u.id, mime, buf, cfg.now()]);
    return { id, url: `/u/${id}` };
  });

  // ---------- community posts ----------
  async function savePost(u, body, existing) {
    const title = str(body.title, 200, 'title');
    const content = str(body.content, 20000, 'content');
    const draft = !!body.draft;
    if (!draft && (title.length < 5 || content.length < 20)) throw bad('post_too_short', 'Add a title and at least a few lines');
    const cat = body.category ? await db.get('SELECT id FROM categories WHERE slug = ?', [String(body.category)]) : null;
    if (body.category && !cat) throw bad('invalid_category');
    if (body.district && !DISTRICT_IDS.has(body.district)) throw bad('invalid_district');
    const img = str(body.image_url, 200, 'image_url');
    if (img && !/^\/u\/[a-f0-9]{32}$/.test(img)) throw bad('invalid_image');
    const summary = content.replace(/\s+/g, ' ').slice(0, 160);
    const c = classify(title, content);
    const status = draft ? 'draft' : cfg.autoPublish ? 'published' : 'pending';
    // Optional scheduling: publish_at (ISO time) between now and 30 days ahead. The feed only shows stories whose time has come.
    let when = cfg.now();
    if (body.publish_at) {
      const t = Date.parse(String(body.publish_at));
      if (!Number.isFinite(t) || t > cfg.now() + 30 * 86400e3) throw bad('invalid_schedule', 'Pick a time within the next 30 days');
      if (t > cfg.now()) when = t;
    }
    const vals = [title, summary, content, img, cat ? cat.id : null, body.district || '', status, body.mark_haram ? 1 : 0, c.is_haram ? 1 : 0, c.terms.join(',')];
    if (existing) {
      await db.run(`UPDATE news SET title = ?, summary = ?, content = ?, image_url = ?, category_id = ?, district = ?, status = ?,
        author_marked_haram = ?, haram_auto = ?, haram_terms = ?, published_at = ? WHERE id = ?`, [...vals, when, existing.id]);
      return existing.id;
    }
    const r = await db.run(`INSERT INTO news (title, summary, content, image_url, category_id, district, status, author_marked_haram,
      haram_auto, haram_terms, author_user_id, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [...vals, u.id, when, cfg.now()]);
    return Number(r.rows[0].id);
  }
  route('POST', '/api/posts', async (req, q, p, body) => {
    const u = await needUser(req);
    rate(`post:${u.id}`, 20, 60 * 60e3);
    const id = await savePost(u, body, null);
    const n = await db.get('SELECT status FROM news WHERE id = ?', [id]);
    return { id, status: n.status };
  });
  route('PUT', '/api/posts/:id', async (req, q, { id }, body) => {
    const u = await needUser(req);
    const ex = await db.get('SELECT * FROM news WHERE id = ? AND author_user_id = ?', [intParam(id, 0, 0, 1e12), u.id]);
    if (!ex) throw new HttpError(404, 'not_found');
    await savePost(u, body, ex);
    const n = await db.get('SELECT status FROM news WHERE id = ?', [ex.id]);
    return { id: ex.id, status: n.status };
  });
  route('DELETE', '/api/posts/:id', async (req, q, { id }) => {
    const u = await needUser(req);
    const r = await db.run('DELETE FROM news WHERE id = ? AND author_user_id = ?', [intParam(id, 0, 0, 1e12), u.id]);
    if (!r.changes) throw new HttpError(404, 'not_found');
    return { deleted: true };
  });
  route('GET', '/api/me/posts', async (req, q) => {
    const u = await needUser(req);
    const drafts = q.drafts === '1';
    const rows = await db.all(`${NEWS_SELECT} WHERE n.author_user_id = ? AND n.status ${drafts ? "= 'draft'" : "<> 'draft'"} ORDER BY n.published_at DESC LIMIT 200`, [u.id]);
    const now = cfg.now();
    return { items: rows.map((n) => ({ ...newsCard(n), status: n.status, content: n.content, district: n.district,
      author_marked_haram: !!n.author_marked_haram,
      scheduled: n.status === 'published' && Number(n.published_at) > now })) };
  });

  route('POST', '/api/suggestions', async (req, q, p, body) => {
    const u = await userFromReq(req);
    rate(`suggest:${req.socket.remoteAddress}`, 10, 60 * 60e3);
    const name = str(body.name, 100, 'name');
    if (name.length < 2) throw bad('invalid_name', 'Enter the channel name');
    const logo = str(body.logo_url, 200, 'logo_url');
    if (logo && !/^\/u\/[a-f0-9]{32}$/.test(logo)) throw bad('invalid_image');
    const r = await db.run('INSERT INTO suggestions (user_id, name, website, district, note, logo_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [u ? u.id : null, name, str(body.website, 200, 'website'), str(body.district, 60, 'district'), str(body.note, 500, 'note'), logo, cfg.now()]);
    return { id: Number(r.rows[0].id), status: 'pending' };
  });

  route('GET', '/api/me/suggestions', async (req) => {
    const u = await needUser(req);
    const rows = await db.all('SELECT id, name, website, district, note, logo_url, status, created_at FROM suggestions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [u.id]);
    return { items: rows.map((r) => ({ ...r, id: Number(r.id), created_at: new Date(Number(r.created_at)).toISOString() })) };
  });

  // ---------- admin (Bearer ADMIN_TOKEN) ----------
  route('POST', '/api/admin/news', async (req, q, p, body) => {
    needAdmin(req);
    const title = str(body.title, 300, 'title');
    if (!title) throw bad('missing_title');
    const content = str(body.content, 50000, 'content');
    const summary = str(body.summary, 500, 'summary') || content.replace(/\s+/g, ' ').slice(0, 160);
    const cat = body.category ? await db.get('SELECT id FROM categories WHERE slug = ?', [String(body.category)]) : null;
    const chan = body.channel_id ? await db.get('SELECT id FROM channels WHERE id = ?', [intParam(body.channel_id, 0, 0, 1e12)]) : null;
    const c = classify(title, summary, content);
    const pub = body.published_at ? Date.parse(body.published_at) : cfg.now();
    const r = await db.run(`INSERT INTO news (title, summary, content, image_url, category_id, channel_id, district, source_url, published_at,
      status, is_featured, haram_auto, haram_terms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?) RETURNING id`,
      [title, summary, content, str(body.image_url, 500, 'image_url'), cat ? cat.id : null, chan ? chan.id : null, str(body.district, 60, 'district'),
        str(body.source_url, 500, 'source_url'), Number.isFinite(pub) ? pub : cfg.now(), body.featured ? 1 : 0, c.is_haram ? 1 : 0, c.terms.join(','), cfg.now()]);
    const id = Number(r.rows[0].id);
    if (chan) await notifyFollowers(id, chan.id, title);
    return { id, is_haram: c.is_haram, terms: c.terms };
  });
  route('PATCH', '/api/admin/news/:id', async (req, q, { id }, body) => {
    needAdmin(req);
    const nid = intParam(id, 0, 0, 1e12);
    if (body.haram_override !== undefined) await db.run('UPDATE news SET haram_override = ? WHERE id = ?', [body.haram_override === null ? null : body.haram_override ? 1 : 0, nid]);
    if (body.status !== undefined) {
      if (!['published', 'pending', 'rejected'].includes(body.status)) throw bad('invalid_status');
      await db.run('UPDATE news SET status = ? WHERE id = ?', [body.status, nid]);
    }
    if (body.featured !== undefined) await db.run('UPDATE news SET is_featured = ? WHERE id = ?', [body.featured ? 1 : 0, nid]);
    return { ok: true };
  });
  route('DELETE', '/api/admin/news/:id', async (req, q, { id }) => {
    needAdmin(req);
    await db.run('DELETE FROM news WHERE id = ?', [intParam(id, 0, 0, 1e12)]);
    return { deleted: true };
  });
  route('GET', '/api/admin/pending', async (req) => {
    needAdmin(req);
    const posts = await db.all(`${NEWS_SELECT} WHERE n.status = 'pending' ORDER BY n.created_at DESC LIMIT 100`);
    const suggestions = await db.all("SELECT * FROM suggestions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100");
    return { posts: posts.map((n) => newsCard(n, true)), suggestions };
  });
  route('POST', '/api/admin/channels', async (req, q, p, body) => {
    needAdmin(req);
    const name = str(body.name, 100, 'name');
    if (!name) throw bad('missing_name');
    const slug = (str(body.slug, 60, 'slug') || name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'channel') + '-' + crypto.randomBytes(2).toString('hex');
    const r = await db.run('INSERT INTO channels (slug, name, description, website, district, logo_url, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
      [slug, name, str(body.description, 500, 'description'), str(body.website, 200, 'website'), str(body.district, 60, 'district'),
        str(body.logo_url, 500, 'logo_url'), body.verified ? 1 : 0, cfg.now()]);
    return { id: Number(r.rows[0].id) };
  });
  route('POST', '/api/admin/feeds', async (req, q, p, body) => {
    needAdmin(req);
    const url = str(body.url, 500, 'url');
    if (!/^https?:\/\//.test(url)) throw bad('invalid_url');
    const chan = await db.get('SELECT id FROM channels WHERE id = ?', [intParam(body.channel_id, 0, 0, 1e12)]);
    if (!chan) throw bad('invalid_channel');
    const cat = body.category ? await db.get('SELECT id FROM categories WHERE slug = ?', [String(body.category)]) : null;
    const r = await db.run('INSERT INTO feeds (url, channel_id, category_id) VALUES (?, ?, ?) RETURNING id', [url, chan.id, cat ? cat.id : null]);
    return { id: Number(r.rows[0].id) };
  });
  route('GET', '/api/admin/feeds', async (req) => { needAdmin(req); return { feeds: await db.all('SELECT * FROM feeds ORDER BY id') }; });
  route('DELETE', '/api/admin/feeds/:id', async (req, q, { id }) => {
    needAdmin(req);
    await db.run('DELETE FROM feeds WHERE id = ?', [intParam(id, 0, 0, 1e12)]);
    return { deleted: true };
  });

  // ---------- http ----------
  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.wav': 'audio/wav' };
  function send(res, status, obj, headers = {}) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(body);
  }
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let n = 0;
      req.on('data', (c) => { n += c.length; if (n > max) { reject(new HttpError(413, 'too_large', 'File is too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const pathname = decodeURIComponent(url.pathname);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
      return res.end();
    }
    try {
      if (req.method === 'GET' && pathname.startsWith('/u/')) {
        const id = pathname.slice(3);
        if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpError(404, 'not_found');
        const f = await db.get('SELECT mime, data FROM uploads WHERE id = ?', [id]);
        if (!f) throw new HttpError(404, 'not_found');
        res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': f.data.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
        return res.end(f.data);
      }
      if (req.method === 'GET' && (pathname.startsWith('/static/') || pathname === '/' || pathname === '/privacy')) {
        const rel = pathname === '/' ? 'index.html' : pathname === '/privacy' ? 'privacy.html' : pathname.slice(8);
        const file = path.normalize(path.join(STATIC_DIR, rel));
        if (!file.startsWith(STATIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'not_found');
        const data = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'public, max-age=86400' });
        return res.end(data);
      }
      let match = null;
      // Android's HttpURLConnection cannot send PATCH, so the app sends POST with this header.
      const ov = String(req.headers['x-http-method-override'] || '').toUpperCase();
      const method = req.method === 'POST' && ov === 'PATCH' ? 'PATCH' : req.method;
      let methodMismatch = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.method !== method) { methodMismatch = true; continue; }
        match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
        break;
      }
      if (!match) throw new HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'method_not_allowed' : 'not_found');
      let body = {};
      let raw = null;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        const isUpload = pathname === '/api/uploads';
        raw = await readBody(req, isUpload ? MAX_UPLOAD : 256 * 1024);
        if (!isUpload && raw.length) {
          try { body = JSON.parse(raw.toString('utf8')); } catch { throw bad('invalid_json'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('invalid_json');
        }
      }
      const q = Object.fromEntries(url.searchParams);
      const out = await match.r.handler(req, q, match.params, body, raw);
      send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      console.error('[error]', req.method, pathname, e);
      send(res, 500, { error: 'server_error', message: 'Something went wrong' });
    }
  }

  return { handle, server: () => http.createServer(handle), notifyFollowers };
}

module.exports = { createApp };
