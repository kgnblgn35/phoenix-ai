require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
// Barındırma servisleri (Render vb.) bir proxy arkasında çalışır; gerçek kullanıcı IP'sini okumak için gerekli
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const KEDY_URL = "https://api.kedy.dev/v1/chat/completions";

const MAX_MESSAGE_LEN = 1000; // tek mesaj sınırı
const MAX_HISTORY = 12; // modele gönderilen en fazla mesaj sayısı

// Üretim ayarları: yanıt uzunluğunu sınırlar ve tekrarı azaltır.
// Kedy bu alanları desteklemezse istek bu alanlar olmadan yeniden denenir.
const GEN_PARAMS = { max_tokens: 800, temperature: 0.6, frequency_penalty: 0.7, presence_penalty: 0.3 };

// Kısa sistem talimatı (küçük modeller uzun talimatlarda şaşırabiliyor)
const SYSTEM_PROMPT = `Sen Phoenix AI'sın. Lise ve üniversite öğrencilerine ne araştıracaklarını önerirsin. Her zaman Türkçe yazarsın. Kitap, yazar veya web sitesi adı vermezsin; yalnızca konu ve arama için anahtar kelime önerirsin. Aynı şeyi tekrar etmezsin.`;

// Öğrencinin mesajından sonra eklenen net görev tanımı
const TASK_FORMAT = `Görevin: Bu öğrenciye araştırma konusu öner. Öğrencinin yazdıklarını tekrar etme, kendi önerilerini yaz. 3 konu öner ve her konuyu şu biçimde yaz:

**Konu başlığı**
Neden uygun: tek cümle
Anahtar kelimeler: 3-5 arama terimi
Zorluk: kolay, orta veya zor

En sonda "İlk adım:" ile başlayan tek bir cümle yaz. Kitap veya yazar adı verme. Yanıtın Türkçe olsun ve 200 kelimeyi geçmesin.
Öğrencinin ilgi alanı hiç anlaşılmıyorsa konu önermek yerine tek bir kısa soru sor.`;

app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Kötüye kullanım koruması (API kotasını korur) ---
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN) || 6; // IP başına dakikada en fazla istek
const DAILY_MAX = Number(process.env.DAILY_LIMIT) || 500; // tüm kullanıcılar için günlük toplam istek
const hits = new Map(); // ip -> son istek zamanları
let dailyCount = 0;
let dailyDay = new Date().toDateString();

function limiter(req, res, next) {
  const now = Date.now();
  const today = new Date().toDateString();
  if (today !== dailyDay) {
    dailyDay = today;
    dailyCount = 0;
  }
  if (dailyCount >= DAILY_MAX) {
    return res.status(429).json({ error: "Bugünkü kullanım sınırına ulaşıldı. Yarın tekrar dene." });
  }
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    return res.status(429).json({ error: "Çok hızlı gidiyorsun. Bir dakika bekleyip tekrar dene." });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  dailyCount++;
  next();
}

// Eski kayıtları düzenli temizle (bellek şişmesin)
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of hits) {
    const recent = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// Barındırma servisinin sağlık kontrolü için
app.get("/health", (req, res) => res.json({ ok: true }));

// İstemciden gelen sohbet geçmişini doğrular ve kırpar
function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const clean = [];
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      return null;
    }
    const content = m.content.trim();
    if (!content) continue;
    if (content.length > 4000) return null;
    clean.push({ role: m.role, content });
  }
  const recent = clean.slice(-MAX_HISTORY);
  // Son mesaj mutlaka kullanıcıdan olmalı
  if (recent.length === 0 || recent[recent.length - 1].role !== "user") return null;
  if (recent[recent.length - 1].content.length > MAX_MESSAGE_LEN) return null;
  return recent;
}

// Model aynı cümleyi döngüye sokarsa tekrarları siler, yarım kalan son cümleyi atar.
// degenerate: yanıtın büyük kısmı tekrardan oluşuyorsa true (kullanılamaz yanıt).
function cleanReply(text) {
  const seen = new Set();
  let total = 0;
  let dupes = 0;
  const lines = text.split(/\r?\n/).map((line) => {
    const parts = line.split(/(?<=[.!?…])\s+/);
    const kept = [];
    for (const p of parts) {
      const key = p.toLowerCase().replace(/[^a-zçğıöşü0-9]/g, "");
      if (key.length >= 15) {
        total++;
        if (seen.has(key)) {
          dupes++;
          continue;
        }
        seen.add(key);
      }
      kept.push(p);
    }
    return kept.join(" ");
  });

  let out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  // Cümle ortasında kesilmişse son tam cümleye kadar kısalt
  if (!/[.!?…:)*"”]$/.test(out)) {
    const idx = Math.max(out.lastIndexOf(". "), out.lastIndexOf("! "), out.lastIndexOf("? "), out.lastIndexOf("\n"));
    if (idx > out.length * 0.4) out = out.slice(0, idx + 1).trim();
  }

  return { text: out, degenerate: total >= 6 && dupes / total > 0.4 };
}

// Yanıt işe yarar mı? Ya anahtar kelimeli öneri içermeli ya da öğrenciye soru sormalı.
// (Modelin sadece öğrencinin cümlesini tekrar ettiği yanıtları eler.)
function isUsable(reply) {
  return /anahtar/i.test(reply) || reply.includes("?");
}

// Yöntem A: kısa sistem talimatı + son mesajı görev içine al
function buildPayloadA(messages) {
  const last = messages[messages.length - 1].content;
  const hasHistory = messages.length > 1;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.slice(0, -1),
    {
      role: "user",
      content:
        `Öğrencinin mesajı:\n"""${last}"""\n\n${TASK_FORMAT}` +
        (hasHistory ? "\nÖnceki konuşmayı dikkate al ve daha önce önerdiğin konuları tekrar etme." : ""),
    },
  ];
}

// Yöntem B (yedek): sistem rolü kullanmadan her şeyi tek kullanıcı mesajına koy
function buildPayloadB(messages) {
  const transcript = messages
    .map((m) => `${m.role === "user" ? "Öğrenci" : "Phoenix AI"}: ${m.content}`)
    .join("\n");
  return [
    {
      role: "user",
      content: `${SYSTEM_PROMPT}\n\nKonuşma:\n${transcript}\n\n${TASK_FORMAT}\n\nPhoenix AI:`,
    },
  ];
}

function callKedy(apiKey, messages, signal, extra) {
  return fetch(KEDY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "novaq", messages, ...extra }),
    signal,
  });
}

// Tek bir deneme: Kedy'yi çağırır, yanıtı temizler. Hata durumunda { status, error } döner.
async function attempt(apiKey, payload, signal) {
  let upstream = await callKedy(apiKey, payload, signal, GEN_PARAMS);

  // Bazı API'ler fazladan alanları kabul etmez; o durumda alanlar olmadan bir kez daha dene
  if (upstream.status === 400 || upstream.status === 422) {
    console.warn("Kedy üretim ayarlarını reddetti, ayarsız yeniden deniyor.");
    upstream = await callKedy(apiKey, payload, signal, {});
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("Kedy API hatası:", upstream.status, detail.slice(0, 300));
    const error =
      upstream.status === 401 || upstream.status === 403
        ? "API anahtarı geçersiz veya yetkisiz."
        : upstream.status === 429
        ? "Çok fazla istek gönderildi, biraz bekleyip tekrar dene."
        : "Yapay zekâ servisi şu an yanıt veremiyor.";
    return { fatal: true, error };
  }

  const data = await upstream.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw) return { fatal: false, reply: null };

  const { text, degenerate } = cleanReply(raw);
  if (degenerate || text.length < 20 || !isUsable(text)) return { fatal: false, reply: null };
  return { fatal: false, reply: text };
}

app.post("/api/chat", limiter, async (req, res) => {
  const apiKey = process.env.KEDY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Sunucuda KEDY_API_KEY tanımlı değil. .env dosyasını kontrol et." });
  }

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages) {
    return res.status(400).json({
      error: `Geçersiz mesaj. Mesaj boş olmamalı ve en fazla ${MAX_MESSAGE_LEN} karakter olmalı.`,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    // Önce yöntem A, işe yaramaz yanıt gelirse yöntem B ile bir kez daha dene
    const builders = [buildPayloadA, buildPayloadB];
    for (let i = 0; i < builders.length; i++) {
      const result = await attempt(apiKey, builders[i](messages), controller.signal);
      if (result.fatal) return res.status(502).json({ error: result.error });
      if (result.reply) return res.json({ reply: result.reply });
      console.warn(`Yöntem ${i === 0 ? "A" : "B"}: kullanılamaz yanıt (tekrar, yankı veya boş).`);
    }

    return res.status(502).json({
      error: "Yapay zekâ bu sefer düzgün bir yanıt üretemedi. Mesajını biraz daha ayrıntılı yazıp tekrar dene.",
    });
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "İstek zaman aşımına uğradı. Tekrar dene." });
    }
    console.error("Sunucu hatası:", err.message);
    res.status(500).json({ error: "Beklenmeyen bir hata oluştu." });
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(PORT, () => {
  console.log(`Phoenix AI çalışıyor: http://localhost:${PORT}`);
});
