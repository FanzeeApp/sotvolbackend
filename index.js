const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const multer = require("multer");
const { Pool } = require("pg");
const dotenv = require("dotenv");
const FormData = require("form-data");

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
    const ext =
      path.extname(file.originalname) ||
      (file.mimetype.startsWith("video/") ? ".mp4" : ".jpg");
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024, files: 7 },
  fileFilter: (_req, file, cb) => {
    if (file.fieldname === "video") {
      if (file.mimetype.startsWith("video/")) {
        cb(null, true);
      } else {
        cb(new Error("Video fayl yuklang (MP4, MOV)."));
      }
    } else if (file.fieldname === "images") {
      if (file.mimetype.startsWith("image/")) {
        cb(null, true);
      } else {
        cb(new Error("Faqat rasm fayllarini yuklash mumkin."));
      }
    } else {
      cb(null, false);
    }
  },
});

const uploadFields = upload.fields([
  { name: "video", maxCount: 1 },
  { name: "images", maxCount: 6 },
]);

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
    if (!initData) {
      console.log("verifyTelegramWebAppData: no initData");
      return { valid: false };
    }

    if (!botToken) {
      console.log("verifyTelegramWebAppData: no botToken");
      return { valid: false };
    }

    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get("hash");
    if (!hash) {
      console.log("verifyTelegramWebAppData: no hash in initData");
      return { valid: false };
    }

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

    if (calculatedHash !== hash) {
      console.log("verifyTelegramWebAppData: hash mismatch");
      return { valid: false };
    }

    const userJson = urlParams.get("user");
    if (userJson) {
      try {
        const user = JSON.parse(userJson);
        const userId = Number(user.id);
        console.log("verifyTelegramWebAppData: valid, userId:", userId);
        return { valid: true, userId };
      } catch (parseError) {
        console.error("verifyTelegramWebAppData: user parse error:", parseError);
        return { valid: true };
      }
    }

    console.log("verifyTelegramWebAppData: valid but no user data");
    return { valid: true };
  } catch (error) {
    console.error("verifyTelegramWebAppData: error:", error);
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
  if (!userId) {
    console.log("isAdminUser: no userId provided");
    return false;
  }

  const numericUserId = Number(userId);
  if (!Number.isFinite(numericUserId) || numericUserId <= 0) {
    console.log("isAdminUser: invalid userId:", userId);
    return false;
  }

  // Check bootstrap admins first
  if (bootstrapAdminIds.includes(numericUserId)) {
    console.log("isAdminUser: found in bootstrap admins:", numericUserId);
    return true;
  }

  // Check database
  try {
    const result = await pool.query(
      "SELECT 1 FROM admins WHERE telegram_user_id = $1 LIMIT 1",
      [numericUserId],
    );
    const isAdmin = result.rowCount > 0;
    console.log("isAdminUser: DB check for", numericUserId, "result:", isAdmin);
    return isAdmin;
  } catch (error) {
    console.error("isAdminUser: DB error:", error);
    return false;
  }
};

// Check admin by phone number
const isAdminByPhone = async (phone) => {
  if (!phone) {
    console.log("isAdminByPhone: no phone provided");
    return false;
  }

  // Normalize phone number (remove spaces, dashes, etc.)
  const normalizedPhone = String(phone).replace(/[^\d+]/g, "");
  if (normalizedPhone.length < 9) {
    console.log("isAdminByPhone: invalid phone:", phone);
    return false;
  }

  try {
    // Check admins table for phone
    const result = await pool.query(
      "SELECT telegram_user_id FROM admins WHERE phone LIKE $1 OR phone LIKE $2 LIMIT 1",
      [`%${normalizedPhone.slice(-9)}`, `%${normalizedPhone}`],
    );

    if (result.rowCount > 0) {
      console.log("isAdminByPhone: found admin with phone:", normalizedPhone);
      return { isAdmin: true, userId: result.rows[0].telegram_user_id };
    }

    // Also check users table and then admins
    const userResult = await pool.query(
      "SELECT telegram_user_id FROM users WHERE phone LIKE $1 OR phone LIKE $2 LIMIT 1",
      [`%${normalizedPhone.slice(-9)}`, `%${normalizedPhone}`],
    );

    if (userResult.rowCount > 0) {
      const userId = userResult.rows[0].telegram_user_id;
      const isAdmin = await isAdminUser(userId);
      console.log("isAdminByPhone: found user, isAdmin:", isAdmin);
      return { isAdmin, userId };
    }

    console.log("isAdminByPhone: phone not found:", normalizedPhone);
    return { isAdmin: false, userId: null };
  } catch (error) {
    console.error("isAdminByPhone: DB error:", error);
    return { isAdmin: false, userId: null };
  }
};

// Get user info by telegram ID
const getUserByTelegramId = async (userId) => {
  if (!userId) return null;
  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE telegram_user_id = $1",
      [Number(userId)],
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error("getUserByTelegramId: DB error:", error);
    return null;
  }
};

const requireAdminFromRequest = async (req) => {
  const initData = req.body?.initData || req.query?.initData || "";
  const directUserId = req.body?.userId || req.query?.userId || "";

  // Try initData first
  if (initData) {
    const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
    if (verification.valid) {
      const admin = await isAdminUser(verification.userId);
      if (admin) {
        return { ok: true, userId: verification.userId };
      }
      return { ok: false, status: 403, error: "Ruxsat yo'q." };
    }
  }

  // Fallback: try userId directly (from Telegram SDK)
  if (directUserId) {
    const numericUserId = Number(directUserId);
    if (Number.isFinite(numericUserId) && numericUserId > 0) {
      const admin = await isAdminUser(numericUserId);
      if (admin) {
        console.log("requireAdminFromRequest: admin verified by userId:", numericUserId);
        return { ok: true, userId: numericUserId };
      }
      return { ok: false, status: 403, error: "Ruxsat yo'q." };
    }
  }

  // Dev bypass
  if (DEV_BYPASS) {
    return { ok: true, userId: null };
  }

  return { ok: false, status: 401, error: "Auth kerak." };
};

const formatPriceUsd = (value) => {
  const raw = String(value || "").trim();
  const numeric = raw.replace(/[^\d.]/g, "");
  if (!numeric) return raw;
  return `$${numeric}`;
};

const formatListingMessage = (data, code, priceFormatted) => {
  const exchangeIcon = data.exchange ? "✅" : "❌";

  return [
    `🔖 Kod: #${code}`,
    ``,
    `📲 Nasiyaga: @sotvolnasiya_bot`,
    ``,
    `🧩 Model: ${data.model}`,
    `✨ Nomi: ${data.name}`,
    `📦 Xotira: ${data.storage}`,
    `🎨 Rang: ${data.color}`,
    `🧪 Holati: ${data.condition}`,
    ``,
    `💵 Narxi: ${priceFormatted}`,
    ``,
    `🔋 Batareya: ${data.battery}%`,
    `📮 Karobka: ${data.box}`,
    `🛡 Garantiya: ${data.warranty}`,
    `🔁 Obmen: ${data.exchange ? "Bor" : "Yo'q"} ${exchangeIcon}`,
    `⭐ Bahosi: ${data.rating}/5`,
    ``,
    `📲 Nasiyaga olish: @sotvolnasiya_bot`,
    ``,
    `Telefon: +998990999111`,
    `telegram: @SHAAAKHZOD1`,
    `Instagram: sotvol.uz`,
  ].join("\n");
};

const sendTelegramMediaGroup = (caption, files) => {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
      console.error("Telegram config missing:", {
        hasToken: !!TELEGRAM_BOT_TOKEN,
        channelId: TELEGRAM_CHANNEL_ID
      });
      return reject(new Error("Telegram konfiguratsiyasi yo'q."));
    }

    console.log("Sending to Telegram channel:", TELEGRAM_CHANNEL_ID, "Files:", files.length);

    const media = files.map((_file, index) => ({
      type: "photo",
      media: `attach://file${index}`,
      ...(index === 0 ? { caption } : {}),
    }));

    const form = new FormData();
    form.append("chat_id", String(TELEGRAM_CHANNEL_ID));
    form.append("media", JSON.stringify(media));

    files.forEach((file, index) => {
      const fileStream = fs.createReadStream(file.path);
      const filename = file.originalname || `photo-${index + 1}.jpg`;
      form.append(`file${index}`, fileStream, { filename });
    });

    const submitOptions = {
      host: "api.telegram.org",
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
      protocol: "https:",
    };

    form.submit(submitOptions, (err, res) => {
      if (err) {
        console.error("Telegram submit error:", err);
        return reject(err);
      }

      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (!result.ok) {
            console.error("Telegram API error:", result);
            return reject(new Error(result.description || "Telegram API error"));
          }
          console.log("Telegram send success, message_id:", result.result?.[0]?.message_id);
          resolve(result.result?.[0]?.message_id);
        } catch (parseError) {
          console.error("Telegram response parse error:", parseError, data);
          reject(parseError);
        }
      });

      res.on("error", (resError) => {
        console.error("Telegram response error:", resError);
        reject(resError);
      });
    });
  });
};

// ─── ffmpeg: video info & compression ───

const getVideoInfo = (filePath) => {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height,duration",
        "-show_entries", "stream_tags=rotate",
        "-show_entries", "format=duration",
        "-of", "json",
        filePath,
      ],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          const info = JSON.parse(stdout);
          const stream = info.streams?.[0] || {};
          const format = info.format || {};
          let width = stream.width || 0;
          let height = stream.height || 0;
          const rotation = parseInt(stream.tags?.rotate || "0", 10);

          // iPhone records portrait video as landscape + 90° rotation flag
          // Swap dimensions so Telegram displays correct aspect ratio
          if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
            console.log(`[ffprobe] Rotation ${rotation}° detected, swapping ${width}x${height} -> ${height}x${width}`);
            [width, height] = [height, width];
          }

          resolve({ width, height, duration: Math.ceil(parseFloat(stream.duration || format.duration || "0")) });
        } catch (e) {
          reject(e);
        }
      },
    );
  });
};

const compressVideoToFit = (inputPath, outputPath, targetMB) => {
  return new Promise(async (resolve, reject) => {
    let info;
    try {
      info = await getVideoInfo(inputPath);
    } catch (e) {
      return reject(new Error("ffprobe topilmadi. Serverda ffmpeg o'rnatilmagan."));
    }

    if (!info.duration || info.duration <= 0) {
      return reject(new Error("Video davomiyligi aniqlanmadi."));
    }

    const targetBytes = targetMB * 1024 * 1024;
    const audioBitrateKbps = 128;
    const targetBits = targetBytes * 8;
    const audioBits = audioBitrateKbps * 1000 * info.duration;
    const videoBitrateKbps = Math.floor((targetBits - audioBits) / info.duration / 1000);

    if (videoBitrateKbps < 200) {
      return reject(new Error("Video juda uzun — 50MB ga siqib bo'lmaydi. Qisqaroq video yuklang."));
    }

    console.log(
      `[ffmpeg] Compressing: ${info.duration}s, target ${targetMB}MB, vbr=${videoBitrateKbps}kbps`,
    );

    execFile(
      "ffmpeg",
      [
        "-i", inputPath,
        "-c:v", "libx264",
        "-b:v", `${videoBitrateKbps}k`,
        "-maxrate", `${Math.floor(videoBitrateKbps * 1.5)}k`,
        "-bufsize", `${videoBitrateKbps * 2}k`,
        "-preset", "medium",
        "-c:a", "aac",
        "-b:a", `${audioBitrateKbps}k`,
        "-movflags", "+faststart",
        "-y",
        outputPath,
      ],
      { timeout: 600000, maxBuffer: 10 * 1024 * 1024 },
      (err) => {
        if (err) return reject(err);
        resolve(info);
      },
    );
  });
};

// ─── Telegram: send video ───

const sendTelegramVideo = (caption, filePath, filename, mimetype, metadata) => {
  return new Promise((resolve, reject) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHANNEL_ID) {
      return reject(new Error("Telegram konfiguratsiyasi yo'q."));
    }

    const stat = fs.statSync(filePath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    console.log("Sending video to Telegram:", sizeMB, "MB", metadata);

    if (stat.size > 50 * 1024 * 1024) {
      return reject(new Error(`Video ${sizeMB}MB — Telegram limiti 50MB.`));
    }

    const form = new FormData();
    form.append("chat_id", String(TELEGRAM_CHANNEL_ID));
    form.append("caption", caption);
    form.append("supports_streaming", "true");
    if (metadata?.width > 0) form.append("width", String(metadata.width));
    if (metadata?.height > 0) form.append("height", String(metadata.height));
    if (metadata?.duration > 0) form.append("duration", String(metadata.duration));
    form.append("video", fs.createReadStream(filePath), {
      filename: filename || "video.mp4",
      contentType: mimetype || "video/mp4",
    });

    const submitOptions = {
      host: "api.telegram.org",
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendVideo`,
      protocol: "https:",
    };

    form.submit(submitOptions, (err, res) => {
      if (err) {
        console.error("Telegram video submit error:", err);
        return reject(err);
      }

      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (!result.ok) {
            console.error("Telegram video API error:", result);
            return reject(new Error(result.description || "Telegram video API error"));
          }
          console.log("Telegram video sent, message_id:", result.result?.message_id);
          resolve(result.result?.message_id);
        } catch (parseError) {
          console.error("Telegram video parse error:", parseError);
          reject(parseError);
        }
      });

      res.on("error", (resError) => {
        console.error("Telegram video response error:", resError);
        reject(resError);
      });
    });
  });
};

const cleanupVideoFile = (videoFile) => {
  if (!videoFile || !videoFile.path) return;
  fs.unlink(videoFile.path, (err) => {
    if (err) console.error("Failed to delete video:", videoFile.path, err);
    else console.log("Video file deleted:", videoFile.path);
  });
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
    const phone = req.body?.phone || "";

    // Try phone-based verification first (more reliable)
    if (phone) {
      const phoneResult = await isAdminByPhone(phone);
      console.log("/api/auth/verify: phone check:", phone, "result:", phoneResult);
      if (phoneResult.userId) {
        return res.json({
          isAdmin: phoneResult.isAdmin,
          userId: phoneResult.userId,
          verifiedBy: "phone",
        });
      }
    }

    // Fall back to initData verification
    if (!initData) {
      console.log("/api/auth/verify: no initData, DEV_BYPASS:", DEV_BYPASS);
      if (DEV_BYPASS) {
        return res.json({ isAdmin: true, development: true });
      }
      return res.json({ isAdmin: false });
    }

    const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
    if (!verification.valid) {
      console.log("/api/auth/verify: verification failed");
      // If initData fails but we have phone, try phone again
      if (phone) {
        const phoneResult = await isAdminByPhone(phone);
        if (phoneResult.userId) {
          return res.json({
            isAdmin: phoneResult.isAdmin,
            userId: phoneResult.userId,
            verifiedBy: "phone",
          });
        }
      }
      return res.json({ isAdmin: false });
    }

    const admin = await isAdminUser(verification.userId);

    // Also get user's phone for caching on frontend
    const userInfo = await getUserByTelegramId(verification.userId);

    console.log("/api/auth/verify: userId:", verification.userId, "isAdmin:", admin);
    return res.json({
      isAdmin: admin,
      userId: verification.userId,
      phone: userInfo?.phone || null,
      verifiedBy: "initData",
    });
  } catch (error) {
    console.error("/api/auth/verify error:", error);
    return res.status(500).json({ isAdmin: false });
  }
});

// Phone-only verification endpoint
app.post("/api/auth/verify-phone", async (req, res) => {
  try {
    const phone = req.body?.phone || "";

    if (!phone) {
      return res.status(400).json({ error: "Telefon raqam kerak.", isAdmin: false });
    }

    const result = await isAdminByPhone(phone);
    console.log("/api/auth/verify-phone:", phone, "result:", result);

    return res.json({
      isAdmin: result.isAdmin,
      userId: result.userId,
      verifiedBy: "phone",
    });
  } catch (error) {
    console.error("/api/auth/verify-phone error:", error);
    return res.status(500).json({ isAdmin: false });
  }
});

// User ID lookup endpoint - get user info and admin status by Telegram user ID
app.post("/api/auth/verify-userid", async (req, res) => {
  try {
    const userId = req.body?.userId;

    if (!userId) {
      return res.status(400).json({ error: "User ID kerak.", isAdmin: false });
    }

    const numericUserId = Number(userId);
    if (!Number.isFinite(numericUserId) || numericUserId <= 0) {
      return res.status(400).json({ error: "User ID noto'g'ri.", isAdmin: false });
    }

    // Check if user is admin
    const isAdmin = await isAdminUser(numericUserId);

    // Get user info including phone
    const userInfo = await getUserByTelegramId(numericUserId);

    console.log("/api/auth/verify-userid:", numericUserId, "isAdmin:", isAdmin, "hasPhone:", !!userInfo?.phone);

    return res.json({
      isAdmin,
      userId: numericUserId,
      phone: userInfo?.phone || null,
      verifiedBy: "userId",
    });
  } catch (error) {
    console.error("/api/auth/verify-userid error:", error);
    return res.status(500).json({ isAdmin: false });
  }
});

app.post("/api/listings", (req, res, next) => {
  // 10 min timeout for large video upload + ffmpeg compression
  req.setTimeout(600000);
  res.setTimeout(600000);
  next();
}, uploadFields, async (req, res) => {
  const videoFiles = req.files?.video || [];
  const imageFiles = req.files?.images || [];
  const videoFile = videoFiles[0] || null;
  const allFiles = [...videoFiles, ...imageFiles];

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

    // Auth check: try initData first, then userId fallback
    const directUserId = req.body?.userId || "";
    let adminVerified = false;

    if (initData) {
      const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
      if (verification.valid) {
        const admin = await isAdminUser(verification.userId);
        if (admin) {
          adminVerified = true;
        } else {
          cleanupFiles(allFiles);
          return res.status(403).json({ success: false, error: "Ruxsat yo'q." });
        }
      }
    }

    if (!adminVerified && directUserId) {
      const numericUserId = Number(directUserId);
      if (Number.isFinite(numericUserId) && numericUserId > 0) {
        const admin = await isAdminUser(numericUserId);
        if (admin) {
          adminVerified = true;
        } else {
          cleanupFiles(allFiles);
          return res.status(403).json({ success: false, error: "Ruxsat yo'q." });
        }
      }
    }

    if (!adminVerified && !DEV_BYPASS) {
      cleanupFiles(allFiles);
      return res.status(401).json({ success: false, error: "Auth kerak." });
    }

    if (!model || !name || !condition || !storage || !color || !box || !price || !battery || !rating) {
      cleanupFiles(allFiles);
      return res.status(400).json({ success: false, error: "Majburiy maydonlar to'ldirilmagan." });
    }

    // Video is mandatory
    if (!videoFile) {
      cleanupFiles(allFiles);
      return res.status(400).json({ success: false, error: "Video yuklash majburiy." });
    }

    // At least 1 image is required
    if (imageFiles.length === 0) {
      cleanupFiles(allFiles);
      return res.status(400).json({ success: false, error: "Kamida 1 ta rasm kerak." });
    }

    const modeValue = mode === "only_channel" ? "only_channel" : "db_channel";
    // Only images go to DB (not video)
    const imageUrls = imageFiles.map((file) => buildPublicUrl(file.filename));
    const priceNumeric = String(price).replace(/[^\d.]/g, "");
    const priceValue = parseFloat(priceNumeric);
    const priceFormatted = formatPriceUsd(price);
    if (!priceNumeric || !Number.isFinite(priceValue)) {
      cleanupFiles(allFiles);
      return res.status(400).json({ success: false, error: "Narx noto'g'ri." });
    }
    const ratingValue = Number(rating);
    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      cleanupFiles(allFiles);
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

    // Send only VIDEO to Telegram channel (not images)
    let telegramMessageId = null;
    let compressedPath = null;
    try {
      // Get video metadata (width, height, duration) for best Telegram quality
      let videoMeta = { width: 0, height: 0, duration: 0 };
      try {
        videoMeta = await getVideoInfo(videoFile.path);
        console.log("[Video] Info:", videoMeta);
      } catch {
        console.log("[Video] ffprobe not available, sending without metadata");
      }

      let sendPath = videoFile.path;

      // If video > 50MB: compress with ffmpeg to fit Telegram limit
      if (videoFile.size > 50 * 1024 * 1024) {
        console.log(`[Video] ${(videoFile.size / (1024 * 1024)).toFixed(1)}MB > 50MB, compressing...`);
        compressedPath = videoFile.path + "_tg.mp4";
        try {
          const compMeta = await compressVideoToFit(videoFile.path, compressedPath, 48);
          videoMeta = { ...videoMeta, ...compMeta };
          sendPath = compressedPath;
          console.log("[Video] Compressed to:", (fs.statSync(compressedPath).size / (1024 * 1024)).toFixed(1), "MB");
        } catch (compErr) {
          console.error("[Video] Compression failed:", compErr.message);
          if (compressedPath) try { fs.unlinkSync(compressedPath); } catch {}
          compressedPath = null;
          // Can't send to Telegram without compression
          if (modeValue === "only_channel") {
            await pool.query("DELETE FROM listings WHERE code = $1", [code]);
            cleanupFiles(imageFiles);
            cleanupVideoFile(videoFile);
            return res.status(400).json({
              success: false,
              error: compErr.message || "Video siqishda xatolik. 50MB dan kichik video yuklang.",
            });
          }
          // For db_channel mode, save listing without Telegram
          sendPath = null;
        }
      }

      if (sendPath) {
        telegramMessageId = await sendTelegramVideo(
          caption,
          sendPath,
          videoFile.originalname || "video.mp4",
          videoFile.mimetype || "video/mp4",
          videoMeta,
        );
        if (telegramMessageId) {
          await pool.query(
            "UPDATE listings SET telegram_message_id = $1 WHERE code = $2",
            [telegramMessageId, code],
          );
        }
      }
    } catch (telegramError) {
      console.error("Telegram video send failed:", telegramError);
      if (modeValue === "only_channel") {
        await pool.query("DELETE FROM listings WHERE code = $1", [code]);
        cleanupFiles(imageFiles);
        cleanupVideoFile(videoFile);
        if (compressedPath) try { fs.unlinkSync(compressedPath); } catch {}
        return res.status(500).json({
          success: false,
          error: `Telegram kanalga video yuborilmadi. ${
            telegramError?.message || "Bot kanalga admin ekanini tekshiring."
          }`,
        });
      }
    } finally {
      // ALWAYS delete video files from disk
      cleanupVideoFile(videoFile);
      if (compressedPath) try { fs.unlinkSync(compressedPath); } catch {}
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
              "Telegram kanalga video yuborilmadi. Bot kanalga admin ekanini tekshiring.",
          }),
    });
  } catch (error) {
    console.error("Listing create error:", error);
    cleanupFiles(imageFiles);
    cleanupVideoFile(videoFile);
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

    // Auth is OPTIONAL for booking - user provides phone for verification
    // If initData is provided, try to extract userId for tracking
    let userId = null;
    if (initData) {
      const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
      if (verification.valid && verification.userId) {
        userId = verification.userId;
        console.log("Booking with verified user:", userId);
      } else {
        // Invalid initData - just ignore it, don't fail
        console.log("Booking with invalid/missing auth - proceeding anyway");
      }
    } else {
      console.log("Booking without initData - proceeding with phone verification only");
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
    const directUserId = req.body?.userId || "";

    // Try initData first
    if (initData) {
      const verification = verifyTelegramWebAppData(initData, TELEGRAM_BOT_TOKEN);
      if (verification.valid) {
        userId = verification.userId || null;
        admin = await isAdminUser(userId);
      }
    }

    // Fallback: try userId directly
    if (!admin && directUserId) {
      const numericUserId = Number(directUserId);
      if (Number.isFinite(numericUserId) && numericUserId > 0) {
        admin = await isAdminUser(numericUserId);
        if (admin) {
          userId = numericUserId;
          console.log("PATCH booking status: admin verified by userId:", numericUserId);
        }
      }
    }

    if (!admin && !DEV_BYPASS) {
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
