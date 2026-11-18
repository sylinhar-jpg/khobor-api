# Khobor API

The news server behind the Khobor Android app: feed, categories, 64 districts, channels, comments,
accounts with phone or email and a 5-digit PIN, user posts and drafts, channel suggestions,
notifications, an editable Halal keyword filter and optional RSS feeds. Plain Node (22.13+), no framework.

- `npm start` runs it on `$PORT` (default 8080). With `DATABASE_URL` it uses Postgres, otherwise a SQLite file.
- `npm test` runs the API tests.
- Sample stories are made up and marked "নমুনা" (sample).
- Login codes are in **test mode** (`OTP_ECHO=1`): the code is returned to the app and shown on screen. No SMS or email provider is connected.

Environment: `PORT`, `DATABASE_URL`, `PGSSL`, `SQLITE_FILE`, `OTP_ECHO`, `AUTO_PUBLISH_POSTS`, `ADMIN_TOKEN`, `SEED_SAMPLE`, `FEED_INTERVAL_MIN`.
