# Sotvol Backend (PostgreSQL + Telegram)

Bu papka mini app uchun API server.

## O'rnatish

```
cd server
npm install
```

## Sozlash

`server/.env` yarating va quyidagilarni kiriting:

```
PORT=4000
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=1234
DB_NAME=sotvoluzdb
PUBLIC_BASE_URL=http://localhost:4000
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHANNEL_ID=
TELEGRAM_ORDERS_CHAT_ID=
ALLOW_DEV_BYPASS=true
BOOTSTRAP_ADMINS=123456789
```

- `PUBLIC_BASE_URL` rasmlar URL uchun ishlatiladi.
- `TELEGRAM_ORDERS_CHAT_ID` (ixtiyoriy) bron xabarlari yuboriladigan chat ID.
- `ALLOW_DEV_BYPASS=true` bo'lsa, Telegram initData bo'lmagan paytda admin tekshiruvini bypass qiladi.

## Ishga tushirish

```
cd server
npm run start
```

Dev rejim:

```
cd server
npm run dev
```

## DB sxema

Server ishga tushganda `server/db/schema.sql` avtomatik ishlaydi.
