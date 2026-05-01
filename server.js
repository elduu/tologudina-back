require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const { Telegraf } = require("telegraf");
const fetch = require("node-fetch");
const helmet = require("helmet");
const compression = require("compression");

const { v2: cloudinary } = require("cloudinary");
const streamifier = require("streamifier");

// =========================
// ENV
// =========================

const PORT = process.env.PORT || 5000;
const BOT_TOKEN = process.env.BOT_TOKEN;

// =========================
// Cloudinary Setup
// Uses CLOUDINARY_URL
// =========================

cloudinary.config({
  secure: true
});

// =========================
// Database
// =========================

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT) || 10,
});

// =========================
// Express Setup
// =========================

const app = express();

app.use(helmet());
app.use(compression());
app.use(express.json());
const allowedOrigins = [
  "https://weddinginvitation.newblossomequb.net", // correct frontend domain
  "http://localhost:5173" ,
  "https://paulandhella.newblossomequb.net",
"http://localhost:8080"  ,
"https://api.paulandhella.com" ,
"https://paulandhella.com",
"https://www.paulandhella.com",
"https://api.inviteyours.com" ,
"https://Drtolosagudina.inviteyours.com"

              // local dev
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true); // allow Postman / curl

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error("CORS policy: origin not allowed"), false);
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Handle preflight requests
app.options(/.*/, cors());

// =========================
// Database Init
// =========================

async function initDatabase() {

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS rsvps3 (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      attending BOOLEAN,
      wish TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS wedding_photos3(
      id INT AUTO_INCREMENT PRIMARY KEY,
      file_id VARCHAR(255) UNIQUE,
      image_url TEXT NOT NULL,
      sender VARCHAR(255),
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("Database Ready");

}

// =========================
// Health
// =========================

app.get("/", (req, res) => {

  res.send("Wedding API running 🚀");

});

// =========================
// RSVP Routes
// =========================

app.post("/api/rsvp", async (req, res) => {

  try {

    const {
      name,
      attending,
      wish
    } = req.body;

    if (!name || !wish) {

      return res.status(400).json({
        message: "Name and wish required"
      });

    }

    const attendingValue =
      attending === "yes"
        ? 1
        : attending === "no"
        ? 0
        : null;

    await pool.execute(
      `
      INSERT INTO rsvps3
      (name, attending, wish)
      VALUES (?, ?, ?)
      `,
      [name, attendingValue, wish]
    );

    res.json({
      message: "RSVP submitted"
    });

  }
  catch (err) {

    console.error(
      "RSVP Error:",
      err
    );

    res.status(500).json({
      message: "Database error"
    });

  }

});

app.get("/api/rsvp", async (req, res) => {

  try {

    const [rows] =
      await pool.execute(`
        SELECT name, wish
        FROM rsvps3
        ORDER BY created_at DESC
      `);

    res.json(rows);

  }
  catch (err) {

    console.error(
      "Fetch RSVP Error:",
      err
    );

    res.status(500).json({
      message: "Database error"
    });

  }

});

// =========================
// Photo API
// =========================

app.get("/api/wedding-photos", async (req, res) => {

  try {

    const [rows] =
      await pool.execute(`
        SELECT image_url, sender, timestamp
        FROM wedding_photos2
        ORDER BY timestamp DESC
      `);

    res.json(rows);

  }
  catch (err) {

    console.error(
      "Fetch Photos Error:",
      err
    );

    res.status(500).json({
      message: "Failed to fetch photos"
    });

  }

});

// =========================
// Telegram Bot
// =========================

const bot =
  new Telegraf(BOT_TOKEN);

// Upload helper

function uploadToCloudinary(buffer) {

  return new Promise(
    (resolve, reject) => {

      const stream =
        cloudinary.uploader.upload_stream(
          {
            folder: "wedding_photos"
          },
          (error, result) => {

            if (error) reject(error);
            else resolve(result);

          }
        );

      streamifier
        .createReadStream(buffer)
        .pipe(stream);

    }
  );

}

// Telegram Photo Handler
const processedAlbums = new Set();
bot.on("photo", async (ctx) => {
  try {

    const photos = ctx.message.photo;

    const sender =
      ctx.message.from.username ||
      ctx.message.from.first_name ||
      "Guest";

    const photo = photos[photos.length - 1];
    const fileId = photo.file_id;

    // Detect album
    const albumId = ctx.message.media_group_id;

    // Telegram file
    const file =
      await ctx.telegram.getFile(fileId);

    const fileUrl =
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const response =
      await fetch(fileUrl);

    if (!response.ok)
      throw new Error("Download failed");

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    // Upload to Cloudinary
    const result =
      await uploadToCloudinary(buffer);

    const imageUrl =
      result.secure_url;

    // Save to DB
    await pool.execute(
      `
      INSERT IGNORE INTO wedding_photos3
      (file_id, image_url, sender)
      VALUES (?, ?, ?)
      `,
      [fileId, imageUrl, sender]
    );

    // Reply ONLY ONCE per album
    if (albumId) {

      if (!processedAlbums.has(albumId)) {

        processedAlbums.add(albumId);

        await ctx.reply(
          "📸 Photos uploaded successfully! Thank you for sharing your memories 💍"
        );

        // Cleanup after delay
        setTimeout(() => {
          processedAlbums.delete(albumId);
        }, 60000);

      }

    } else {

      // Single photo
      await ctx.reply(
        "📸 Photo uploaded successfully! Thank you for sharing "
      );

    }

  }
  catch (err) {

    console.error(
      "Photo Upload Error:",
      err
    );

    await ctx.reply(
      "❌ Upload failed"
    );

  }
});
// =========================
// Start
// =========================

async function start() {

  try {

    await initDatabase();

    app.listen(
      PORT,
      () => {

        console.log(
          `Server running on port ${PORT}`
        );

      }
    );

    await bot.launch();

    console.log(
      "Telegram Bot Running 🤖"
    );

  }
  catch (err) {

    console.error(
      "Startup Error:",
      err
    );

  }

}

start();

// =========================
// Shutdown
// =========================

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);