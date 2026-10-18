require("dotenv").config();
const express = require("express");
const path = require("path");
const BOOKS = require("./books");

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
const SYSTEM_PROMPT = `Sen Phoenix AI'sın. Lise ve üniversite öğrencilerine ne araştıracaklarını önerirsin. Her zaman Türkçe yazarsın. Konu önerirken kitap, yazar veya web sitesi adı vermezsin; yalnızca konu ve arama için anahtar kelime önerirsin. Aynı şeyi tekrar etmezsin.`;

// Öğrencinin mesajından sonra eklenen net görev tanımı
const TASK_FORMAT = `Görevin: Bu öğrenciye araştırma konusu öner. Öğrencinin yazdıklarını tekrar etme ve "mesajın okundu" gibi giriş cümleleri yazma, doğrudan önerilerle başla. Öğrenciye "sen" diye hitap et. Öğrencinin istediği tarzı (kısa, eğlenceli, kolay vb.) dikkate al. İlgi alanı belirtmemişse merak uyandıran farklı alanlardan (örneğin uzay, psikoloji, teknoloji, tarih, doğa) konular seç. 3 konu öner ve her konuyu şu biçimde yaz (köşeli parantezli yerleri kendi cevabınla doldur, köşeli parantezleri yazma):

**[konu adı]**
Neden uygun: [tek cümle]
Anahtar kelimeler: [3-5 arama terimi]
Zorluk: [kolay, orta veya zor]

En sonda "İlk adım:" ile başlayan tek bir cümle yaz. Bu cümle öğrencinin hemen yapabileceği somut bir eylem olsun, soru olmasın. Kitap veya yazar adı verme. Yanıtın Türkçe olsun ve 200 kelimeyi geçmesin.`;

// Öğrenci son mesajlarında kitap istedi mi?
function asksForBooks(messages) {
  return messages
    .filter((m) => m.role === "user")
    .slice(-2)
    .some((m) => /kitap|roman|okumalık/i.test(m.content));
}

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

// Küçük biçim hatalarını düzeltir: "mesajın okundu" gibi giriş satırlarını ve
// şablondan kopyalanan "Konu başlığı:" etiketini temizler.
function tidyReply(text) {
  return text
    // "[Başlık] - [Yazar]" ve "[Başlık]" satırlarını kalın yazıya çevir, kalan köşeli parantezleri kaldır
    .replace(/^\s*\[([^\]\n]+)\]\s*[-–—]\s*(.+)$/gm, "**$1** - $2")
    .replace(/^\s*\[([^\]\n]+)\]\s*$/gm, "**$1**")
    .replace(/\[([^\]\n]{1,80})\]/g, "$1")
    .split(/\r?\n/)
    .filter((l) => !/öğrencinin mesajı|mesajın okundu|mesajı okundu/i.test(l))
    .join("\n")
    .replace(/\*\*\s*konu (başlığı|adı)\s*:?\s*\*\*\s*(.+)/gi, "**$2**")
    .replace(/^\s*konu (başlığı|adı)\s*:\s*(.+)$/gim, "**$2**")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Yanıt işe yarar mı? Ya anahtar kelimeli öneri içermeli ya da öğrenciye soru sormalı.
// (Modelin sadece öğrencinin cümlesini tekrar ettiği yanıtları eler.)
function isUsable(reply) {
  return /anahtar|neden uygun/i.test(reply) || reply.includes("?");
}

// Önceki yanıtlarda önerilen başlıkları (kalın yazılanlar) toplar
function previousTitles(messages) {
  const titles = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const t of m.content.matchAll(/\*\*([^*\n]{2,80})\*\*/g)) titles.push(t[1].trim());
  }
  return [...new Set(titles)].slice(-12);
}

// Modele önceki yanıtların kendisini DEĞİL, yalnızca özetini veririz.
// Aksi halde küçük model önceki yanıtı olduğu gibi kopyalıyor.
function buildContext(messages) {
  const users = messages.filter((m) => m.role === "user");
  const last = users[users.length - 1].content;
  const earlier = users.slice(-4, -1).map((m) => `"${m.content}"`);
  const prev = previousTitles(messages);

  let ctx = `Öğrencinin mesajı:\n"""${last}"""`;
  if (earlier.length) ctx = `Öğrencinin önceki mesajları: ${earlier.join("; ")}\n\n` + ctx;
  if (prev.length) {
    ctx += `\n\nDaha önce şunları önerdin: ${prev.join(", ")}. Bunları TEKRAR ETME, tamamen farklı öneriler yaz.`;
  }
  return ctx;
}

// Yöntem A: kısa sistem talimatı + tek bir görev mesajı
function buildPayloadA(messages, format) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `${buildContext(messages)}\n\n${format}` },
  ];
}

// Yöntem B (yedek): sistem rolü kullanmadan her şeyi tek kullanıcı mesajına koy
function buildPayloadB(messages, format) {
  return [
    {
      role: "user",
      content: `${SYSTEM_PROMPT}\n\n${buildContext(messages)}\n\n${format}\n\nPhoenix AI:`,
    },
  ];
}

// Yanıttaki tüm başlıklar zaten daha önce önerilmişse bu bir tekrardır
function isRepeat(reply, prevTitles) {
  if (!prevTitles.length) return false;
  const titles = [...reply.matchAll(/\*\*([^*\n]{2,80})\*\*/g)].map((t) => t[1].trim().toLowerCase());
  if (!titles.length) return false;
  const prev = new Set(prevTitles.map((t) => t.toLowerCase()));
  return titles.every((t) => prev.has(t));
}

// "a", "merhaba" gibi içeriksiz mesajlara yapay zekâ çağırmadan cevap veririz
const GREETING_REPLY =
  "Merhaba! Ben Phoenix AI. Ne okumak ya da araştırmak istediğini yaz; sınıfını, ilgi alanlarını ve ne için aradığını (ödev, eğlence, kariyer) eklersen sana daha uygun öneriler bulabilirim.";

function isTooShort(text) {
  const t = text.trim();
  return t.length < 4 || /^(merhaba|selam|selamlar|hey|hi|hello|naber|slm|günaydın|iyi akşamlar)[\s!.?]*$/i.test(t);
}

// Kitap önerileri yapay zekâdan değil, books.js içindeki gerçek kitap listesinden seçilir.
function recommendBooks(messages) {
  const users = messages.filter((m) => m.role === "user").slice(-2);
  const text = users.map((m) => m.content).join(" ").toLocaleLowerCase("tr");
  const seen = new Set(previousTitles(messages).map((t) => t.toLocaleLowerCase("tr")));

  // Konu etiketleri (uzay, polisiye...) tarz etiketlerinden (kısa, sürükleyici...) daha değerlidir
  const STYLE_TAGS = new Set(["kısa", "sürükleyici", "eğlence", "komik", "mizah", "genç", "klasik"]);

  // Etiket yalnızca kelime başında eşleşir ("aşk" etiketi "başka" kelimesine takılmaz)
  const hasTag = (tag) => new RegExp("(^|[^a-zçğıöşü0-9])" + tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(text);

  const scored = BOOKS.map((b) => {
    const matches = b.tags
      .filter((tag) => tag !== "genel" && hasTag(tag))
      .reduce((sum, tag) => sum + (STYLE_TAGS.has(tag) ? 0.5 : 1), 0);
    // Eşleşme yoksa "genel" etiketli kitaplar öne geçer; küçük rastgelelik çeşitlilik sağlar
    const score = matches + (b.tags.includes("genel") ? 0.2 : 0) + Math.random() * 0.25;
    return { book: b, matches, score };
  }).sort((x, y) => y.score - x.score);

  let picks = scored.filter((s) => !seen.has(s.book.title.toLocaleLowerCase("tr"))).slice(0, 3);
  if (picks.length < 3) picks = scored.slice(0, 3);

  const body = picks
    .map(
      ({ book: b }) =>
        `**${b.title}** - ${b.author}\nNeden uygun: ${b.why}\nTür ve uzunluk: ${b.type}, ${b.length}`
    )
    .join("\n\n");

  const hint = picks.every((p) => p.matches === 0)
    ? "\n\nİlgi alanını (örneğin uzay, polisiye, fantastik, tarih) yazarsan sana daha uygun kitaplar bulabilirim."
    : "";

  return `${body}\n\nİlk adım: Beğendiğin bir kitabın adını kütüphane kataloğunda veya kitapçı sitesinde arayıp ilk sayfalarını oku.${hint}`;
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
async function attempt(apiKey, payload, signal, prevTitles) {
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

  const { text: cleaned, degenerate } = cleanReply(raw);
  const text = tidyReply(cleaned);
  if (degenerate || text.length < 20 || !isUsable(text) || isRepeat(text, prevTitles)) {
    return { fatal: false, reply: null };
  }
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

  // İçeriksiz mesajlara (selam, tek harf) yapay zekâ çağırmadan cevap ver
  if (isTooShort(messages[messages.length - 1].content)) {
    return res.json({ reply: GREETING_REPLY });
  }

  // Kitap isteklerini yapay zekâ olmadan, gerçek kitap listesinden yanıtla
  if (asksForBooks(messages)) {
    return res.json({ reply: recommendBooks(messages) });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);

  try {
    // Önce yöntem A, işe yaramaz yanıt gelirse yöntem B ile bir kez daha dene
    const prevTitles = previousTitles(messages);
    const format = TASK_FORMAT;
    const builders = [buildPayloadA, buildPayloadB];
    for (let i = 0; i < builders.length; i++) {
      const result = await attempt(apiKey, builders[i](messages, format), controller.signal, prevTitles);
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
