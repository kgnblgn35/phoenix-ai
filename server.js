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

// Modele verilen rol ve çıktı biçimi
const SYSTEM_PROMPT = `Sen "Phoenix AI" adında, lise ve üniversite öğrencilerine yardım eden bir araştırma konusu rehberisin.
Öğrenci neyi okuyacağını veya araştıracağını bilmediğinde; ilgi alanına, amacına (ders, eğlence, kariyer vb.) ve seviyesine (lise / üniversite) göre konu önerirsin.

Kurallar:
1. Her zaman TÜRKÇE yaz. Sade ve samimi ol.
2. KİTAP, YAZAR, MAKALE veya WEB SİTESİ ADI YAZMA. Öğrenci "kitap öner" dese bile yazma, çünkü bunları yanlış hatırlayabilirsin. Bunun yerine okunabilecek KONULARI ve arama için ANAHTAR KELİMELERİ öner. Öğrenciye bu kelimelerle kütüphanede veya internette gerçek kaynakları kendisinin bulmasını söyle.
3. 3 veya 4 konu öner. Her konuyu tam olarak şu biçimde yaz:
**Konu başlığı**
Neden uygun: tek kısa cümle.
Anahtar kelimeler: 3-5 arama terimi.
Zorluk: kolay, orta veya zor.
4. Öğrencinin seviyesi veya amacı hiç belli değilse konu önermeden önce tek bir kısa soru sor.
5. En sonda öğrencinin hemen atabileceği tek bir küçük ilk adım yaz.
6. Aynı cümleyi veya aynı bilgiyi ASLA tekrar etme. Her konu yalnızca bir kez geçsin. Devam sorularında ("daha kolay olsun", "başka öner") önceki konuları tekrarlama, yeni konular öner.
7. Yanıtın 200 kelimeyi geçmesin.

Örnek yanıt biçimi (konuları örnek alma, sadece biçimi örnek al):
**Antik Mısır'da günlük yaşam**
Neden uygun: Tarihe ilgi duyan biri için ödev konusu bulmak kolay olur.
Anahtar kelimeler: antik Mısır, günlük yaşam, ancient Egypt daily life
Zorluk: kolay

İlk adım: Yukarıdaki anahtar kelimelerden birini seç ve arama motorunda ara.`;

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

  const payload = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages.slice(0, -1),
    // Son mesaja kısa bir hatırlatma ekle (kısa mesajlarda model dili ve biçimi şaşırabiliyor)
    {
      role: "user",
      content: `${messages[messages.length - 1].content}\n\n(Türkçe yaz. Kitap veya yazar adı verme, konu ve anahtar kelime öner. Aynı cümleyi tekrarlama.)`,
    },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    let upstream = await callKedy(apiKey, payload, controller.signal, GEN_PARAMS);

    // Bazı API'ler fazladan alanları kabul etmez; o durumda alanlar olmadan bir kez daha dene
    if (upstream.status === 400 || upstream.status === 422) {
      console.warn("Kedy üretim ayarlarını reddetti, ayarsız yeniden deneniyor.");
      upstream = await callKedy(apiKey, payload, controller.signal, {});
    }

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
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) {
      return res.status(502).json({ error: "Modelden beklenen biçimde yanıt gelmedi." });
    }

    const { text: reply, degenerate } = cleanReply(raw);
    if (degenerate || reply.length < 20) {
      console.warn("Model döngüye girdi veya çok kısa yanıt verdi.");
      return res.status(502).json({
        error: "Yapay zekâ bu sefer düzgün bir yanıt üretemedi. Mesajını biraz daha ayrıntılı yazıp tekrar dene.",
      });
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
