'use strict';
process.env.SQLITE_FILE = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');
const { classify } = require('../src/classify');
const { parseFeed, runFeeds } = require('../src/ingest');

let base, server, db;
const ADMIN = 'test-admin-token-123456';

async function call(method, path, body, token, raw) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) { payload = raw; headers['Content-Type'] = 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(base + path, { method, headers, body: payload });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}

async function register(identifier, name, pin = '1234') {
  const o = await call('POST', '/api/auth/otp', { identifier });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  const v = await call('POST', '/api/auth/otp/verify', { identifier, code: o.body.demo_code });
  assert.equal(v.status, 200);
  const r = await call('POST', '/api/auth/register', { verify_token: v.body.verify_token, name, pin, district: 'Dhaka' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

test.before(async () => {
  db = await open();
  await seed(db);
  const app = createApp(db, { otpEcho: true, adminToken: ADMIN });
  server = app.server();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await db.close(); });

test('classifier: whole words, endings, no false positives', () => {
  assert.deepEqual(classify('অনলাইন জুয়ার অ্যাপ').groups, ['gambling']);
  assert.equal(classify('মদিনা থেকে ফিরলেন').is_haram, false);
  assert.equal(classify('আতশবাজি উৎসব').is_haram, false);
  assert.equal(classify('বাজারে সবজি').is_haram, false);
  assert.equal(classify('মদের দোকান').is_haram, true);
  assert.equal(classify('Casino raid').is_haram, true);
});

test('health, config and halal rules are public', async () => {
  const h = await call('GET', '/api/health');
  assert.equal(h.body.ok, true);
  const c = await call('GET', '/api/config');
  assert.equal(c.body.halal.method, 'keyword');
  assert.ok(c.body.halal.rules.length >= 4);
});

test('categories and districts', async () => {
  const c = await call('GET', '/api/categories');
  assert.equal(c.body.categories.length, 13);
  assert.ok(c.body.categories.every((x) => x.count >= 1));
  const d = await call('GET', '/api/districts');
  assert.equal(d.body.districts.length, 64);
});

test('feed: newest first, pagination, category, district, halal hide', async () => {
  const a = await call('GET', '/api/feed?limit=10');
  assert.equal(a.body.items.length, 10);
  assert.ok(a.body.next);
  const ts = a.body.items.map((x) => Date.parse(x.published_at));
  assert.deepEqual([...ts].sort((x, y) => y - x), ts);
  assert.ok(a.body.items.every((x) => x.is_sample));
  const b = await call('GET', `/api/feed?limit=10&before=${a.body.next}`);
  assert.equal(b.body.items.length, 10);
  assert.ok(!b.body.items.some((x) => a.body.items.find((y) => y.id === x.id)));
  const all = await call('GET', '/api/feed?limit=50');
  assert.equal(all.body.items.length, 35);
  const haram = all.body.items.filter((x) => x.is_haram);
  assert.ok(haram.length >= 5, 'sample has flagged stories');
  const hidden = await call('GET', '/api/feed?limit=50&halal=hide');
  assert.equal(hidden.body.items.length, 35 - haram.length);
  assert.ok(hidden.body.items.every((x) => !x.is_haram));
  const sp = await call('GET', '/api/feed?category=sports');
  assert.ok(sp.body.items.length >= 3 && sp.body.items.every((x) => x.category === 'sports'));
  const kh = await call('GET', '/api/feed?district=Khulna');
  assert.ok(kh.body.items.length >= 1 && kh.body.items.every((x) => x.district === 'Khulna'));
});

test('trending is ordered by views, max 8', async () => {
  const t = await call('GET', '/api/trending');
  assert.ok(t.body.items.length > 0 && t.body.items.length <= 8);
  const v = t.body.items.map((x) => x.views);
  assert.deepEqual([...v].sort((a, b) => b - a), v);
});

test('search finds Bengali text and channels', async () => {
  const s = await call('GET', '/api/search?q=' + encodeURIComponent('মেট্রো'));
  assert.ok(s.body.news.length >= 1);
  const c = await call('GET', '/api/search?q=' + encodeURIComponent('নমুনা খেলা'));
  assert.ok(c.body.channels.length >= 1);
  const none = await call('GET', '/api/search?q=zzzzqqq');
  assert.equal(none.body.news.length, 0);
});

test('article detail, view counting, flagged reason', async () => {
  const all = await call('GET', '/api/feed?limit=50');
  const flagged = all.body.items.find((x) => x.is_haram);
  const d = await call('GET', '/api/news/' + flagged.id);
  assert.equal(d.body.haram_reason, 'keywords');
  assert.ok(d.body.haram_terms.length >= 1);
  assert.ok(d.body.content.length > 20);
  assert.ok(Array.isArray(d.body.related));
  const v1 = await call('POST', `/api/news/${flagged.id}/view`);
  const v2 = await call('POST', `/api/news/${flagged.id}/view`);
  assert.equal(v1.body.counted, true);
  assert.equal(v2.body.counted, false);
  assert.equal((await call('GET', '/api/news/999999')).status, 404);
});

test('auth: OTP, register, login, wrong PIN lockout, reset', async () => {
  assert.equal((await call('POST', '/api/auth/otp', { identifier: '12345' })).status, 400);
  const token = await register('01711000001', 'রহিম');
  assert.equal((await call('POST', '/api/auth/otp', { identifier: '+8801711000001' })).status, 409);
  const me = await call('GET', '/api/me', undefined, token);
  assert.equal(me.body.user.identifier, '+8801711000001');
  // Bengali digits work too
  const l = await call('POST', '/api/auth/login', { identifier: '০১৭১১০০০০০১', pin: '1234' });
  assert.equal(l.status, 200);
  for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/api/auth/login', { identifier: '01711000001', pin: '0000' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { identifier: '01711000001', pin: '0000' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { identifier: '01711000001', pin: '1234' })).status, 429);
  const o = await call('POST', '/api/auth/otp', { identifier: '01711000001', purpose: 'reset' });
  const wrong = await call('POST', '/api/auth/otp/verify', { identifier: '01711000001', purpose: 'reset', code: o.body.demo_code === '000000' ? '111111' : '000000' });
  assert.equal(wrong.body.error, 'otp_wrong');
  const v = await call('POST', '/api/auth/otp/verify', { identifier: '01711000001', purpose: 'reset', code: o.body.demo_code });
  const r = await call('POST', '/api/auth/reset-pin', { verify_token: v.body.verify_token, pin: '5678' });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/me', undefined, token)).status, 401, 'old sessions end after reset');
  assert.equal((await call('POST', '/api/auth/login', { identifier: 'nobody@example.com', pin: '5678' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { identifier: '01711000001', pin: '5678' })).status, 200);
  assert.equal((await call('POST', '/api/auth/reset-pin', { verify_token: v.body.verify_token, pin: '9999' })).status, 400, 'token single-use');
});

test('likes, bookmarks, follows, following feed', async () => {
  const t = await register('dara@example.com', 'Dara');
  const feed = await call('GET', '/api/feed?limit=3');
  const id = feed.body.items[0].id;
  assert.equal((await call('POST', `/api/news/${id}/like`, {})).status, 401);
  const l = await call('POST', `/api/news/${id}/like`, {}, t);
  assert.equal(l.body.liked, true);
  assert.equal(l.body.like_count, 1);
  assert.equal((await call('POST', `/api/news/${id}/like`, {}, t)).body.liked, false);
  await call('POST', `/api/news/${id}/bookmark`, { on: true }, t);
  const bm = await call('GET', '/api/bookmarks', undefined, t);
  assert.equal(bm.body.items[0].id, id);
  const ch = feed.body.items[0].channel_id;
  const f = await call('POST', `/api/channels/${ch}/follow`, {}, t);
  assert.equal(f.body.following, true);
  const fl = await call('GET', '/api/following', undefined, t);
  assert.equal(fl.body.channels.length, 1);
  const ff = await call('GET', '/api/feed?following=1', undefined, t);
  assert.ok(ff.body.items.length >= 1 && ff.body.items.every((x) => x.channel_id === ch));
  const det = await call('GET', '/api/news/' + id, undefined, t);
  assert.equal(det.body.bookmarked, true);
  assert.equal(det.body.following, true);
  const chans = await call('GET', '/api/channels', undefined, t);
  assert.equal(chans.body.channels.length, 8);
  assert.equal(chans.body.channels.find((c) => c.id === ch).following, true);
});

test('comments: post, reply notifies, anonymous, like, delete', async () => {
  const a = await register('01811000002', 'Amina');
  const b = await register('01911000003', 'Bashir');
  const id = (await call('GET', '/api/feed?limit=1')).body.items[0].id;
  assert.equal((await call('POST', `/api/news/${id}/comments`, { body: '   ' }, a)).status, 400);
  const c1 = await call('POST', `/api/news/${id}/comments`, { body: 'ভালো খবর' }, a);
  const r1 = await call('POST', `/api/news/${id}/comments`, { body: 'সহমত', parent_id: c1.body.id, anonymous: true }, b);
  assert.equal(r1.status, 200);
  const list = await call('GET', `/api/news/${id}/comments`, undefined, a);
  const top = list.body.comments.find((c) => c.id === c1.body.id);
  assert.equal(top.replies.length, 1);
  assert.equal(top.replies[0].author, 'বেনামী পাঠক');
  assert.equal(top.mine, true);
  const n = await call('GET', '/api/notifications', undefined, a);
  assert.equal(n.body.unread, 1);
  assert.equal(n.body.items[0].kind, 'reply');
  assert.equal(n.body.items[0].title, 'বেনামী পাঠক', 'anonymous reply does not reveal name');
  const lk = await call('POST', `/api/comments/${c1.body.id}/like`, {}, b);
  assert.equal(lk.body.likes, 1);
  assert.equal((await call('DELETE', `/api/comments/${c1.body.id}`, {}, b)).status, 404, 'cannot delete others');
  assert.equal((await call('DELETE', `/api/comments/${c1.body.id}`, {}, a)).status, 200);
  await call('POST', '/api/notifications/read', {}, a);
  assert.equal((await call('GET', '/api/notifications/unread', undefined, a)).body.unread, 0);
});

test('profile edit, username, photo upload', async () => {
  const t = await register('01611000004', 'Karim');
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  assert.equal((await call('POST', '/api/uploads', undefined, t, Buffer.from('hello world, not an image'))).status, 400);
  const up = await call('POST', '/api/uploads', undefined, t, png);
  assert.equal(up.status, 200);
  const img = await call('GET', up.body.url);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const p = await call('PATCH', '/api/me', { username: 'karim_bd', bio: 'পাঠক', photo_url: up.body.url, district: 'Sylhet' }, t);
  assert.equal(p.body.user.username, 'karim_bd');
  assert.equal(p.body.user.district, 'Sylhet');
  assert.equal((await call('GET', '/api/username-available?u=karim_bd')).body.available, false);
  const t2 = await register('01611000005', 'Other');
  assert.equal((await call('PATCH', '/api/me', { username: 'karim_bd' }, t2)).status, 409);
  assert.equal((await call('PATCH', '/api/me', { district: 'Atlantis' }, t)).status, 400);
  assert.equal((await call('PATCH', '/api/me', { pin: '4321', old_pin: '0000' }, t)).status, 401);
  assert.equal((await call('PATCH', '/api/me', { pin: '4321', old_pin: '1234' }, t)).status, 200);
});

test('community posts: draft, publish, auto flag, my posts, delete account', async () => {
  const t = await register('01511000006', 'Reporter');
  const d = await call('POST', '/api/posts', { title: 'খসড়া', content: '', draft: true }, t);
  assert.equal(d.body.status, 'draft');
  assert.equal((await call('POST', '/api/posts', { title: 'x', content: 'y' }, t)).status, 400);
  const p = await call('PUT', `/api/posts/${d.body.id}`, { title: 'এলাকায় ক্যাসিনোর বিজ্ঞাপন নিয়ে ক্ষোভ', content: 'স্থানীয় বাসিন্দারা আপত্তি জানিয়েছেন এবং বিজ্ঞাপন সরানোর দাবি করেছেন।', category: 'country', district: 'Feni' }, t);
  assert.equal(p.body.status, 'published');
  const n = await call('GET', `/api/news/${d.body.id}`);
  assert.equal(n.body.is_haram, true);
  assert.equal(n.body.is_community, true);
  assert.equal(n.body.channel_name, 'Reporter');
  const mine = await call('GET', '/api/me/posts', undefined, t);
  assert.equal(mine.body.items.length, 1);
  const drafts = await call('GET', '/api/me/posts?drafts=1', undefined, t);
  assert.equal(drafts.body.items.length, 0);
  assert.equal((await call('DELETE', '/api/me', { pin: '9999' }, t)).status, 401);
  assert.equal((await call('DELETE', '/api/me', { pin: '1234' }, t)).status, 200);
  assert.equal((await call('GET', `/api/news/${d.body.id}`)).status, 404);
  assert.equal((await call('GET', '/api/me', undefined, t)).status, 401);
});

test('admin: needs token, override flag, follower alerts on new story', async () => {
  assert.equal((await call('POST', '/api/admin/news', { title: 'x' })).status, 401);
  const u = await register('01311000007', 'Follower');
  await call('POST', '/api/channels/1/follow', {}, u);
  const n = await call('POST', '/api/admin/news', { title: 'নতুন সংবাদ', content: 'বিস্তারিত', channel_id: 1, category: 'national' }, ADMIN);
  assert.equal(n.status, 200);
  const notes = await call('GET', '/api/notifications', undefined, u);
  assert.equal(notes.body.items[0].kind, 'channel_post');
  await call('PATCH', `/api/admin/news/${n.body.id}`, { haram_override: true }, ADMIN);
  const d = await call('GET', `/api/news/${n.body.id}`);
  assert.equal(d.body.is_haram, true);
  assert.equal(d.body.haram_reason, 'editor');
  const s = await call('POST', '/api/suggestions', { name: 'নতুন চ্যানেল', website: 'https://example.com' });
  assert.equal(s.body.status, 'pending');
  const pend = await call('GET', '/api/admin/pending', undefined, ADMIN);
  assert.equal(pend.body.suggestions.length, 1);
});

test('feed ingestion parses RSS and stores headline + link only', async () => {
  const xml = `<rss><channel><item><title><![CDATA[পরীক্ষা শিরোনাম]]></title><link>https://example.org/a</link>
    <guid>a1</guid><description>&lt;p&gt;ছোট বিবরণ&lt;/p&gt;</description><pubDate>Tue, 17 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  assert.equal(parseFeed(xml)[0].title, 'পরীক্ষা শিরোনাম');
  await call('POST', '/api/admin/feeds', { url: 'https://example.org/rss', channel_id: 2, category: 'national' }, ADMIN);
  const fake = async () => ({ ok: true, text: async () => xml });
  assert.equal(await runFeeds(db, { fetchImpl: fake }), 1);
  assert.equal(await runFeeds(db, { fetchImpl: fake }), 0, 'no duplicates');
  const s = await call('GET', '/api/search?q=' + encodeURIComponent('শিরোনাম'));
  const item = await call('GET', '/api/news/' + s.body.news[0].id);
  assert.equal(item.body.source_url, 'https://example.org/a');
  assert.equal(item.body.content, '');
});

test('bad input is rejected cleanly', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', body: '{not json' });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('GET', '/static/../src/app.js')).status, 404);
  assert.equal((await call('GET', '/static/sample/sports-1.jpg')).status, 200);
});

test('auth check tells new and existing accounts apart', async () => {
  await register('01755500011', 'Check User');
  const a = await call('POST', '/api/auth/check', { identifier: '+8801755500011' });
  assert.equal(a.status, 200); assert.equal(a.body.exists, true); assert.equal(a.body.identifier, '+8801755500011');
  const b = await call('POST', '/api/auth/check', { identifier: 'nobody@example.com' });
  assert.equal(b.body.exists, false);
  const c = await call('POST', '/api/auth/check', { identifier: 'not valid' });
  assert.equal(c.status, 400);
});

test('POST with X-HTTP-Method-Override: PATCH updates the profile (Android client path)', async () => {
  const token = await register('01755500012', 'Override User');
  const r = await fetch(base + '/api/me', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-HTTP-Method-Override': 'PATCH' }, body: JSON.stringify({ bio: 'hello' }) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).user.bio, 'hello');
});

test('my suggestions lists only my own channel suggestions', async () => {
  const token = await register('01755500013', 'Suggest User');
  const h = token;
  const r = await call('POST', '/api/suggestions', { name: 'Test Channel', website: 'https://example.com', district: 'Satkhira', note: 'local news' }, h);
  assert.equal(r.status, 200);
  const l = await call('GET', '/api/me/suggestions', undefined, h);
  assert.equal(l.status, 200);
  assert.equal(l.body.items.length, 1);
  assert.equal(l.body.items[0].name, 'Test Channel');
  assert.equal(l.body.items[0].status, 'pending');
  const anon = await call('GET', '/api/me/suggestions');
  assert.equal(anon.status, 401);
});

test('scheduled posts stay out of the feed until their time, and show as scheduled in my posts', async () => {
  const token = await register('01755500014', 'Schedule User');
  const at = new Date(Date.now() + 2 * 3600e3).toISOString();
  const r = await call('POST', '/api/posts', { title: 'সময় ঠিক করা খবর পরীক্ষা', content: 'এই খবরটি দুই ঘণ্টা পরে প্রকাশ হওয়ার কথা, তাই এখনই ফিডে দেখা যাবে না।', category: 'national', publish_at: at }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const f = await call('GET', '/api/feed?limit=50');
  assert.ok(!f.body.items.some((n) => n.id === r.body.id));
  const mine = await call('GET', '/api/me/posts', undefined, token);
  const p = mine.body.items.find((n) => n.id === r.body.id);
  assert.equal(p.scheduled, true);
  assert.equal(p.category, 'national');
  const far = await call('POST', '/api/posts', { title: 'অনেক দূরের তারিখ', content: 'এই খবরটি অনেক দূরের তারিখে রাখা হয়েছে, তাই সার্ভার ফিরিয়ে দেবে।', publish_at: new Date(Date.now() + 90 * 86400e3).toISOString() }, token);
  assert.equal(far.status, 400);
  assert.equal(far.body.error, 'invalid_schedule');
  const now = await call('POST', '/api/posts', { title: 'এখনই প্রকাশ খবর', content: 'এই খবরটি এখনই প্রকাশ হবে এবং ফিডে সাথে সাথে দেখা যাবে, কোনো দেরি নেই।' }, token);
  const f2 = await call('GET', '/api/feed?limit=50');
  assert.ok(f2.body.items.some((n) => n.id === now.body.id));
});

test('channel suggestions accept an uploaded logo and reject outside links', async () => {
  const token = await register('01755500015', 'Logo User');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const up = await call('POST', '/api/uploads', undefined, token, png);
  assert.equal(up.status, 200);
  const r = await call('POST', '/api/suggestions', { name: 'Logo Channel', logo_url: up.body.url }, token);
  assert.equal(r.status, 200);
  const l = await call('GET', '/api/me/suggestions', undefined, token);
  assert.equal(l.body.items[0].logo_url, up.body.url);
  const bad = await call('POST', '/api/suggestions', { name: 'Bad Logo', logo_url: 'https://evil.example/x.png' }, token);
  assert.equal(bad.status, 400);
});
