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

// Modele verilen rol ve çıktı biçimi
const SYSTEM_PROMPT = `Sen "Phoenix AI" adında, lise ve üniversite öğrencilerine yardım eden bir araştırma konusu rehberisin.
Öğrenci neyi okuyacağını veya araştıracağını bilmediğinde; ilgi alanına, amacına (ders, iş, eğlence, kariyer vb.) ve seviyesine (lise / üniversite) göre net yönlendirmeler yaparsın.
Kurallar:
- DİL: Her zaman TÜRKÇE yanıt ver. Öğrenci açıkça başka bir dilde yazmadıkça veya başka bir dil istemedikçe asla başka dile geçme.
- Sade ve samimi yaz.
- 3 ila 5 araştırma konusu öner. Her konu için şu biçimi kullan:
  **Konu başlığı**
  Neden uygun: (1 cümle)
  Anahtar kelimeler: 3-5 arama terimi (Türkçe ve gerekiyorsa İngilizce)
  Zorluk/süre: (kolay-orta-zor, tahmini okuma süresi)
- Belirli kitap, makale, yazar veya web sitesi adı UYDURMA. Yalnızca konu ve anahtar kelime öner; gerçek kaynakları öğrencinin bu kelimelerle kendisinin bulmasını sağla.
- Öğrencinin seviyesi veya amacı belirsizse önce tek bir kısa soru sor.
- Sonunda öğrencinin atabileceği tek bir küçük ilk adım öner.
- Devam sorularında ("daha kolay olsun", "başka öner" vb.) önceki konuşmayı dikkate al.
- Cevabı kısa tut ve gereksiz uzatma.`;

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
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const upstream = await fetch(KEDY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "novaq",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...messages.slice(0, -1),
          // Son mesaja dil hatırlatması ekle (kısa Türkçe mesajlarda model dili şaşırabiliyor)
          {
            role: "user",
            content: `${messages[messages.length - 1].content}\n\n(Yanıtını Türkçe yaz.)`,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.error("Kedy API hatası:", upstream.status, detail.slice(0, 300));
      const text =
        upstream.status === 401 || upstream.status === 403
          ? "API anahtarı geçersiz veya yetkisiz."
          : upstream.status === 429
          ? "Çok fazla istek gönderildi, biraz bekleyip tekrar dene."
          : "Yapay zekâ servisi şu an yanıt veremiyor.";
      return res.status(502).json({ error: text });
    }

    const data = await upstream.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (!reply) {
      return res.status(502).json({ error: "Modelden beklenen biçimde yanıt gelmedi." });
    }
    res.json({ reply });
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
