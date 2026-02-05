const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const { Pool } = require("pg");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = Number(process.env.PORT || 4000);
const DATABASE_URL = process.env.DATABASE_URL || "";
const DB_HOST = process.env.DB_HOST || "localhost";
const DB_PORT = Number(process.env.DB_PORT || 5432);
const DB_USER = process.env.DB_USER || "postgres";
const DB_PASSWORD = process.env.DB_PASSWORD || "";
const DB_NAME = process.env.DB_NAME || "sotvoluzdb";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || "";
const TELEGRAM_ORDERS_CHAT_ID = process.env.TELEGRAM_ORDERS_CHAT_ID || "";
const ALLOW_DEV_BYPASS = String(process.env.ALLOW_DEV_BYPASS || "false") === "true";
const DEV_BYPASS =
  ALLOW_DEV_BYPASS &&
  (PUBLIC_BASE_URL.includes("localhost") || PUBLIC_BASE_URL.includes("127.0.0.1"));
const BOOTSTRAP_ADMINS =
  process.env.BOOTSTRAP_ADMINS || process.env.ADMIN_IDS || "";

const bootstrapAdminIds = BOOTSTRAP_ADMINS.split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const shouldUseSsl = DATABASE_URL.includes("sslmode=require");
const pool = new Pool(
  DATABASE_URL
    ? {
        connectionString: DATABASE_URL,
        ssl: shouldUseSsl ? { rejectUnauthorized: false } : undefined,
      }
    : {
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
      },
);

const app = express();

app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Faqat rasm fayllarini yuklash mumkin."));
    }
  },
});

const schemaPath = path.join(__dirname, "db", "schema.sql");

const ensureSchema = async () => {
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await pool.query(schemaSql);
};

const seedAdmins = async () => {
  if (bootstrapAdminIds.length === 0) return;
  const values = bootstrapAdminIds.map((_, index) => `($${index + 1})`).join(", ");
  await pool.query(
    `INSERT INTO admins (telegram_user_id)
     VALUES ${values}
     ON CONFLICT (telegram_user_id) DO NOTHING`,
    bootstrapAdminIds,
  );
};

const buildPublicUrl = (filename) => `/uploads/${filename}`;

const verifyTelegramWebAppData = (initData, botToken) => {
  try {
    if (!initData) return { valid: false };

    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get("hash");
    if (!hash) return { valid: false };

    urlParams.delete("hash");
    const dataCheckString = Array.from(urlParams.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== hash) return { valid: false };

    const userJson = urlParams.get("user");
    if (userJson) {
      const user = JSON.parse(userJson);
      return { valid: true, userId: user.id };
    }

    return { valid: true };
  } catch (error) {
    console.error("Verification error:", error);
    return { valid: false };
  }
};

const getOrdersChatId = () => {
  if (TELEGRAM_ORDERS_CHAT_ID) {
    return TELEGRAM_ORDERS_CHAT_ID;
  }
  return TELEGRAM_CHANNEL_ID;
};

const sendTelegramMessage = async (chatId, text, replyMarkup) => {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    throw new Error("Telegram chat konfiguratsiyasi yo'q.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    },
  );

  const result = await response.json();
  if (!result.ok) {
    console.error("Telegram message error:", result);
    throw new Error(result.description || "Telegram message error");
  }

  return result.result;
};

const fetchAdminIds = async () => {
  const result = await pool.query("SELECT telegram_user_id FROM admins");
  return result.rows
    .map((row) => Number(row.telegram_user_id))
    .filter((value) => Number.isFinite(value) && value > 0);
};

const sendBookingNotificationToAdmins = async (text, orderCode) => {
  const inlineKeyboard = {
    inline_keyboard: [
      [
        { text: "Tasdiqlash", callback_data: `booking:${orderCode}:reserved` },
        { text: "Bekor qilish", callback_data: `booking:${orderCode}:canceled` },
      ],
    ],
  };

  const ordersChatId = getOrdersChatId();
  if (!ordersChatId) return;
  await sendTelegramMessage(ordersChatId, text, inlineKeyboard);
};

const generateOrderCode = () => {
  const random = Math.floor(100000 + Math.random() * 900000);
  return `BR${random}`;
};

const isAdminUser = async (userId) => {
  if (!userId) return false;
  if (bootstrapAdminIds.includes(Number(userId))) {
    return true;
  }
  const result = await pool.query(
    "SELECT 1 FROM admins WHERE telegram_user_id = $1 LIMIT 1",
    [userId],
  );
  return result.rowCount > 0;
};

const requireAdminFromRequest = async (req) => {
  const initData = req.body?.initData || req.query?.initData || "";
  if (!initData) {
    return DEV_BYPASS
      ? { ok: true, userId: null }
      : { ok: false, status: 401, error: "Auth kerak." };
  }

  const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
  if (!verification.valid) {
    return { ok: false, status: 401, error: "Auth xato." };
  }

  const admin = await isAdminUser(verification.userId);
  if (!admin) {
    return { ok: false, status: 403, error: "Ruxsat yo'q." };
  }

  return { ok: true, userId: verification.userId };
};

const formatPriceUsd = (value) => {
  const raw = String(value || "").trim();
  const numeric = raw.replace(/[^\d.]/g, "");
  if (!numeric) return raw;
  return `$${numeric}`;
};

const formatListingMessage = (data, code, priceFormatted) => {
  return [
    "SOTVOL UZ - Yangi elon",
    "-------------------",
    `Kod: #${code}`,
    "",
    `Model: ${data.model}`,
    `Nomi: ${data.name}`,
    `Xotira: ${data.storage}`,
    `Rang: ${data.color}`,
    `Holati: ${data.condition}`,
    "",
    `Narxi: ${priceFormatted}`,
    "",
    `Batareya: ${data.battery}`,
    `Karobka: ${data.box}`,
    `Garantiya: ${data.warranty}`,
    `Obmen: ${data.exchange ? "Bor" : "Yo'q"}`,
    `Bahosi: ${data.rating}/5`,
    "",
    "Nasiyaga hisoblash va olish uchun: @sotvolnasiya_bot",
  ].join("
");
};

const sendTelegramMediaGroup = async (caption, files) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
    throw new Error("Telegram konfiguratsiyasi yo'q.");
  }

  const media = files.map((_file, index) => ({
    type: "photo",
    media: `attach://file${index}`,
    ...(index === 0 ? { caption } : {}),
  }));

  const form = new FormData();
  form.append("chat_id", String(TELEGRAM_CHANNEL_ID));
  form.append("media", JSON.stringify(media));

  files.forEach((file, index) => {
    const buffer = fs.readFileSync(file.path);
    const blob = new Blob([buffer]);
    form.append(`file${index}`, blob, file.originalname || `photo-${index + 1}.jpg`);
  });

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
    {
      method: "POST",
      body: form,
    },
  );

  const result = await response.json();
  if (!result.ok) {
    console.error("Telegram API error:", result);
    throw new Error(result.description || "Telegram API error");
  }

  return result.result?.[0]?.message_id;
};

const listingStatusCase = `
  CASE
    WHEN EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.listing_code = listings.code AND b.status = 'sold'
    ) THEN 'sold'
    WHEN EXISTS (
      SELECT 1 FROM bookings b
      WHERE b.listing_code = listings.code AND b.status = 'reserved'
    ) THEN 'reserved'
    ELSE 'available'
  END
`;

const listingStatusSql = `${listingStatusCase} AS listing_status`;

const mapListingRow = (row) => ({
  code: row.code,
  mode: row.mode,
  model: row.model,
  name: row.name,
  condition: row.condition,
  storage: row.storage,
  color: row.color,
  box: row.box,
  price: Number(row.price),
  priceFormatted: row.price_formatted,
  battery: row.battery,
  exchange: row.exchange,
  warranty: row.warranty,
  rating: row.rating,
  status: row.listing_status || "available",
  images: normalizeImages(row.images),
  telegramMessageId: row.telegram_message_id,
  createdAt: row.created_at,
});

const normalizeImages = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch (error) {
        return [];
      }
    }
    const withoutBraces = trimmed.replace(/^\{/, "").replace(/\}$/, "");
    if (!withoutBraces) return [];
    return withoutBraces
      .split(",")
      .map((item) => item.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);
  }
  return [];
};

const mapBookingRow = (row) => ({
  orderCode: row.order_code,
  listingCode: row.listing_code,
  fullName: row.full_name,
  phone: row.phone,
  downPayment: Number(row.down_payment),
  months: row.months,
  monthlyPayment: Number(row.monthly_payment),
  totalPayment: Number(row.total_payment),
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const cleanupFiles = (files) => {
  if (!files) return;
  files.forEach((file) => {
    fs.unlink(file.path, () => {});
  });
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/verify", async (req, res) => {
  try {
    const initData = req.body?.initData || "";

    if (!initData) {
      if (DEV_BYPASS) {
        return res.json({ isAdmin: true, development: true });
      }
      return res.json({ isAdmin: false });
    }

    const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
    if (!verification.valid) {
      return res.json({ isAdmin: false });
    }

    const admin = await isAdminUser(verification.userId);
    return res.json({ isAdmin: admin, userId: verification.userId });
  } catch (error) {
    console.error("Verify error:", error);
    return res.status(500).json({ isAdmin: false });
  }
});

app.post("/api/listings", upload.array("images", 6), async (req, res) => {
  const files = req.files || [];
  try {
    const {
      initData,
      mode,
      model,
      name,
      condition,
      storage,
      color,
      box,
      price,
      battery,
      exchange,
      warranty,
      rating,
    } = req.body || {};

    if (!initData && !DEV_BYPASS) {
      cleanupFiles(files);
      return res.status(401).json({ success: false, error: "Auth kerak." });
    }

    if (initData) {
      const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
      if (!verification.valid) {
        cleanupFiles(files);
        return res.status(401).json({ success: false, error: "Auth xato." });
      }
      const admin = await isAdminUser(verification.userId);
      if (!admin) {
        cleanupFiles(files);
        return res.status(403).json({ success: false, error: "Ruxsat yo'q." });
      }
    }

    if (!model || !name || !condition || !storage || !color || !box || !price || !battery || !rating) {
      cleanupFiles(files);
      return res.status(400).json({ success: false, error: "Majburiy maydonlar to'ldirilmagan." });
    }

    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, error: "Kamida 1 ta rasm kerak." });
    }

    const modeValue = mode === "only_channel" ? "only_channel" : "db_channel";
    const imageUrls = files.map((file) => buildPublicUrl(file.filename));
    const priceNumeric = String(price).replace(/[^\d.]/g, "");
    const priceValue = parseFloat(priceNumeric);
    const priceFormatted = formatPriceUsd(price);
    if (!priceNumeric || !Number.isFinite(priceValue)) {
      cleanupFiles(files);
      return res.status(400).json({ success: false, error: "Narx noto'g'ri." });
    }
    const ratingValue = Number(rating);
    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      cleanupFiles(files);
      return res.status(400).json({ success: false, error: "Baholash 1-5 oralig'ida bo'lishi kerak." });
    }
    const exchangeValue = String(exchange) === "true" || exchange === true;

    const insertResult = await pool.query(
      `INSERT INTO listings (
        mode, model, name, condition, storage, color, box,
        price, price_formatted, battery, exchange, warranty, rating, images
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14
      )
      RETURNING code`,
      [
        modeValue,
        model,
        name,
        condition,
        storage,
        color,
        box,
        priceValue,
        priceFormatted,
        battery,
        exchangeValue,
        warranty || "1 oy",
        ratingValue,
        imageUrls,
      ],
    );

    const code = insertResult.rows[0]?.code;
    const caption = formatListingMessage(
      {
        model,
        name,
        condition,
        storage,
        color,
        box,
        price: priceFormatted,
        battery,
        exchange: exchangeValue,
        warranty: warranty || "1 oy",
        rating: ratingValue,
      },
      code,
      priceFormatted,
    );

    let telegramMessageId = null;
    try {
      telegramMessageId = await sendTelegramMediaGroup(caption, files);
      if (telegramMessageId) {
        await pool.query(
          "UPDATE listings SET telegram_message_id = $1 WHERE code = $2",
          [telegramMessageId, code],
        );
      }
    } catch (telegramError) {
      console.error("Telegram send failed:", telegramError);
      if (modeValue === "only_channel") {
        await pool.query("DELETE FROM listings WHERE code = $1", [code]);
        cleanupFiles(files);
        return res.status(500).json({
          success: false,
          error: `Telegram kanalga yuborilmadi. ${
            telegramError?.message || "Bot kanalga admin ekanini tekshiring."
          }`,
        });
      }
    }

    const channelLink =
      TELEGRAM_CHANNEL_ID && TELEGRAM_CHANNEL_ID.startsWith("@") && telegramMessageId
        ? `https://t.me/${TELEGRAM_CHANNEL_ID.slice(1)}/${telegramMessageId}`
        : null;

    return res.json({
      success: true,
      code,
      telegramMessageId,
      channelLink,
      ...(telegramMessageId
        ? {}
        : {
            warning:
              "Telegram kanalga yuborilmadi. Bot kanalga admin ekanini tekshiring.",
          }),
    });
  } catch (error) {
    console.error("Listing create error:", error);
    cleanupFiles(files);
    return res.status(500).json({ success: false, error: "Server xatosi." });
  }
});

app.get("/api/listings", async (req, res) => {
  try {
    const all = String(req.query.all || "").toLowerCase() === "true";
    const statusFilter = String(req.query.status || "").toLowerCase();
    const includeSold = String(req.query.includeSold || "").toLowerCase() === "true";
    const requestedLimit = Number(req.query.limit || 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 500)
      : 50;

    let whereClause = "";
    if (statusFilter === "sold") {
      whereClause = `WHERE ${listingStatusCase} = 'sold'`;
    } else if (statusFilter === "reserved") {
      whereClause = `WHERE ${listingStatusCase} = 'reserved'`;
    } else if (statusFilter === "available") {
      whereClause = `WHERE ${listingStatusCase} = 'available'`;
    } else if (!includeSold) {
      whereClause = `WHERE ${listingStatusCase} <> 'sold'`;
    }

    let query = `SELECT *, ${listingStatusSql} FROM listings ${whereClause} ORDER BY created_at DESC`;
    const params = [];

    if (!all) {
      query += " LIMIT $1";
      params.push(limit);
    }

    const result = await pool.query(query, params);
    return res.json(result.rows.map(mapListingRow));
  } catch (error) {
    console.error("List fetch error:", error);
    return res.status(500).json({ error: "Server xatosi." });
  }
});

app.get("/api/listings/:code", async (req, res) => {
  try {
    const code = Number(req.params.code);
    if (!Number.isFinite(code)) {
      return res.status(400).json({ error: "Kod noto'g'ri." });
    }

    const result = await pool.query(
      `SELECT *, ${listingStatusSql} FROM listings WHERE code = $1`,
      [code],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Topilmadi." });
    }
    return res.json(mapListingRow(result.rows[0]));
  } catch (error) {
    console.error("Listing fetch error:", error);
    return res.status(500).json({ error: "Server xatosi." });
  }
});

app.patch("/api/listings/:code", async (req, res) => {
  try {
    const code = Number(req.params.code);
    if (!Number.isFinite(code)) {
      return res.status(400).json({ error: "Kod noto'g'ri." });
    }

    const adminCheck = await requireAdminFromRequest(req);
    if (!adminCheck.ok) {
      return res.status(adminCheck.status).json({ error: adminCheck.error });
    }

    const existingResult = await pool.query(
      "SELECT * FROM listings WHERE code = $1",
      [code],
    );
    if (existingResult.rowCount === 0) {
      return res.status(404).json({ error: "Topilmadi." });
    }

    const existing = existingResult.rows[0];
    const body = req.body || {};

    const resolveText = (value, fallback) => {
      if (value === undefined) return String(fallback || "");
      if (value === null) return "";
      return String(value).trim();
    };

    const model = resolveText(body.model, existing.model);
    const name = resolveText(body.name, existing.name);
    const condition = resolveText(body.condition, existing.condition);
    const storage = resolveText(body.storage, existing.storage);
    const color = resolveText(body.color, existing.color);
    const box = resolveText(body.box, existing.box);
    const battery = resolveText(body.battery, existing.battery);
    const warranty = resolveText(body.warranty, existing.warranty || "1 oy");

    if (!model || !name || !condition || !storage || !color || !box || !battery) {
      return res.status(400).json({ error: "Majburiy maydonlar to'ldirilmagan." });
    }

    const rawPrice = body.price !== undefined ? body.price : existing.price;
    const priceNumeric = String(rawPrice).replace(/[^\d.]/g, "");
    const priceValue = parseFloat(priceNumeric);
    if (!priceNumeric || !Number.isFinite(priceValue)) {
      return res.status(400).json({ error: "Narx noto'g'ri." });
    }
    const priceFormatted = formatPriceUsd(String(rawPrice));

    const exchangeValue =
      body.exchange !== undefined
        ? String(body.exchange) === "true" || body.exchange === true
        : existing.exchange;

    const ratingRaw = body.rating !== undefined ? body.rating : existing.rating;
    const ratingValue = Number(ratingRaw);
    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      return res.status(400).json({ error: "Baholash 1-5 oralig'ida bo'lishi kerak." });
    }

    await pool.query(
      `UPDATE listings
       SET model = $1,
           name = $2,
           condition = $3,
           storage = $4,
           color = $5,
           box = $6,
           price = $7,
           price_formatted = $8,
           battery = $9,
           exchange = $10,
           warranty = $11,
           rating = $12
       WHERE code = $13`,
      [
        model,
        name,
        condition,
        storage,
        color,
        box,
        priceValue,
        priceFormatted,
        battery,
        exchangeValue,
        warranty,
        ratingValue,
        code,
      ],
    );

    const updated = await pool.query(
      `SELECT *, ${listingStatusSql} FROM listings WHERE code = $1`,
      [code],
    );
    return res.json(mapListingRow(updated.rows[0]));
  } catch (error) {
    console.error("Listing update error:", error);
    return res.status(500).json({ error: "Server xatosi." });
  }
});

app.delete("/api/listings/:code", async (req, res) => {
  try {
    const code = Number(req.params.code);
    if (!Number.isFinite(code)) {
      return res.status(400).json({ error: "Kod noto'g'ri." });
    }

    const adminCheck = await requireAdminFromRequest(req);
    if (!adminCheck.ok) {
      return res.status(adminCheck.status).json({ error: adminCheck.error });
    }

    const existingResult = await pool.query(
      "SELECT * FROM listings WHERE code = $1",
      [code],
    );
    if (existingResult.rowCount === 0) {
      return res.status(404).json({ error: "Topilmadi." });
    }

    const existing = existingResult.rows[0];
    const images = normalizeImages(existing.images);
    images.forEach((image) => {
      if (!image) return;
      const match = image.match(/\/uploads\/(.+)$/);
      const filename = match?.[1] || "";
      if (!filename || filename.includes("..")) return;
      fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
    });

    await pool.query("DELETE FROM listings WHERE code = $1", [code]);
    return res.json({ success: true });
  } catch (error) {
    console.error("Listing delete error:", error);
    return res.status(500).json({ error: "Server xatosi." });
  }
});

app.post("/api/bookings", async (req, res) => {
  try {
    const {
      initData,
      listingCode,
      fullName,
      phone,
      downPayment,
      months,
    } = req.body || {};

    if (!listingCode || !fullName || !phone || !months) {
      return res.status(400).json({ error: "Ma'lumotlar to'liq emas." });
    }

    let userId = null;
    if (initData) {
      const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
      if (!verification.valid) {
        return res.status(401).json({ error: "Auth xato." });
      }
      userId = verification.userId || null;
    } else if (!DEV_BYPASS) {
      return res.status(401).json({ error: "Auth kerak." });
    }

    const listingResult = await pool.query(
      `SELECT *, ${listingStatusSql} FROM listings WHERE code = $1`,
      [Number(listingCode)],
    );

    if (listingResult.rowCount === 0) {
      return res.status(404).json({ error: "Telefon topilmadi." });
    }

    const listing = listingResult.rows[0];
    const listingStatus = listing.listing_status || "available";
    if (listingStatus === "reserved") {
      return res.status(409).json({ error: "Telefon hozircha bron qilingan." });
    }
    if (listingStatus === "sold") {
      return res.status(409).json({ error: "Telefon sotilgan." });
    }
    const price = Number(listing.price);
    const minDownPayment = Math.round(price * 0.3 * 100) / 100;
    const requestedDown = Number(downPayment);
    const monthsValue = Number(months);

    if (!Number.isFinite(monthsValue) || monthsValue < 2 || monthsValue > 12) {
      return res.status(400).json({ error: "Oylar 2-12 oralig'ida bo'lishi kerak." });
    }

    const downPaymentValue = Number.isFinite(requestedDown) && requestedDown > 0
      ? Math.max(requestedDown, minDownPayment)
      : minDownPayment;

    const remaining = Math.max(price - downPaymentValue, 0);
    const totalPayment = Math.round(remaining * (1 + 0.05 * monthsValue) * 100) / 100;
    const monthlyPayment = Math.round((totalPayment / monthsValue) * 100) / 100;

    let orderCode = generateOrderCode();
    let inserted = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const insertResult = await pool.query(
          `INSERT INTO bookings (
            order_code, listing_code, user_id, full_name, phone,
            down_payment, months, monthly_payment, total_payment, status
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, $7, $8, $9, 'pending'
          )
          RETURNING *`,
          [
            orderCode,
            listing.code,
            userId,
            fullName,
            phone,
            downPaymentValue,
            monthsValue,
            monthlyPayment,
            totalPayment,
          ],
        );
        inserted = insertResult.rows[0];
        break;
      } catch (error) {
        if (error.code === "23505") {
          orderCode = generateOrderCode();
        } else {
          throw error;
        }
      }
    }

    if (!inserted) {
      return res.status(500).json({ error: "Buyurtma yaratilmadi." });
    }

    try {
      const message = `Yangi bron:
Buyurtma kodi: ${inserted.order_code}
Telefon kodi: ${listing.code}
Model/Nomi: ${listing.model} ${listing.name}
Narxi: ${listing.price_formatted}
Boshlang'ich to'lov: $${downPaymentValue}
Oylar: ${monthsValue}
Oyiga: $${monthlyPayment}
Jami: $${totalPayment}
Ism: ${fullName}
Telefon: ${phone}
Status: pending`;

      await sendBookingNotificationToAdmins(message, inserted.order_code);
    } catch (error) {
      console.error("Booking Telegram notify failed:", error);
    }

    return res.json(mapBookingRow(inserted));
  } catch (error) {
    console.error("Booking create error:", error);
    return res.status(500).json({ error: "Server xatosi." });
  }
});

app.get("/api/bookings/:orderCode", async (req, res) => {
  try {
    const orderCode = req.params.orderCode;
    const result = await pool.query(
      "SELECT * FROM bookings WHERE order_code = $1",
      [orderCode],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Bron topilmadi." });
    }
    return res.json(mapBookingRow(result.rows[0]));
  } catch (error) {
    console.error("Booking fetch error:", error);
    return res.status(500).json({ error: "Server xatosi." });
  }
});

app.patch("/api/bookings/:orderCode/status", async (req, res) => {
  try {
    const orderCode = req.params.orderCode;
    const { initData, status } = req.body || {};

    const allowedStatuses = ["pending", "reserved", "sold", "canceled"];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Status noto'g'ri." });
    }

    let userId = null;
    let admin = false;
    if (initData) {
      const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
      if (!verification.valid) {
        return res.status(401).json({ error: "Auth xato." });
      }
      userId = verification.userId || null;
      admin = await isAdminUser(userId);
    } else if (!DEV_BYPASS) {
      return res.status(401).json({ error: "Auth kerak." });
    }

    const bookingResult = await pool.query(
      "SELECT * FROM bookings WHERE order_code = $1",
      [orderCode],
    );
    if (bookingResult.rowCount === 0) {
      return res.status(404).json({ error: "Bron topilmadi." });
    }

    const booking = bookingResult.rows[0];
    if (!admin) {
      return res.status(403).json({ error: "Ruxsat yo'q." });
    }

    const updateResult = await pool.query(
      `UPDATE bookings
       SET status = $1, updated_at = NOW()
       WHERE order_code = $2
       RETURNING *`,
      [status, orderCode],
    );

    return res.json(mapBookingRow(updateResult.rows[0]));
  } catch (error) {
    console.error("Booking status error:", error);
    return res.status(500).json({ error: "Server xatosi." });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Server xatosi." });
});

async function start() {
  try {
    await ensureSchema();
    await seedAdmins();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Server start error:", error);
    process.exit(1);
  }
}

start();
