'use strict';
const { open } = require('./db');
const { seed } = require('./seed');
const { createApp } = require('./app');
const { runFeeds } = require('./ingest');

(async () => {
  const db = await open();
  if (process.env.SEED_SAMPLE !== '0') {
    const did = await seed(db);
    if (did) console.log('[seed] sample categories, channels and stories added');
  }
  const app = createApp(db);
  const port = Number(process.env.PORT) || 8080;
  app.server().listen(port, () => console.log(`[khobor] listening on :${port} (${db.kind})`));
  const every = Number(process.env.FEED_INTERVAL_MIN || 15) * 60e3;
  const tick = () => runFeeds(db, { notifyFollowers: app.notifyFollowers }).then((n) => n && console.log(`[feeds] ${n} new`)).catch((e) => console.error('[feeds]', e.message));
  setTimeout(tick, 5000);
  setInterval(tick, every);
})().catch((e) => { console.error(e); process.exit(1); });
