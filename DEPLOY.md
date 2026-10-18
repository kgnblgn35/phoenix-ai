# Phoenix AI — Yayına Alma Rehberi (GitHub + Render)

Bu rehber projeyi internette herkesin açabileceği bir adrese koymayı anlatır.
Render örnek olarak seçildi; arayüz ve ücretsiz plan koşulları değişebilir, güncel bilgi için render.com'a bak.

## 0. Başlamadan önce

- Gerçek API anahtarın yalnızca Render'daki "Environment Variables" bölümüne girilecek.
- `.env` ve `node_modules` GitHub'a **yüklenmeyecek**.

## 1. Kodu GitHub'a yükle

1. github.com'da giriş yap, sağ üstteki **+** → **New repository** de.
2. Adı `phoenix-ai` yaz, **Public** veya **Private** seç, **Create repository** de.
3. Açılan sayfada **uploading an existing file** bağlantısına tıkla.
4. Şu dosyaları sürükle-bırak yap:
   - `server.js`, `books.js`, `package.json`, `README.md`, `DEPLOY.md`, `.gitignore`, `.env.example`
   - `public` klasörünü (içindeki `index.html`, `style.css`, `app.js` ile birlikte) klasör olarak sürükle.
5. **Yüklemeyeceklerin:** `.env`, `node_modules`, `package-lock.json` (yüklersen de sorun olmaz).
6. Aşağıdaki **Commit changes** butonuna bas.
7. Depoda `.env` dosyası **görünmemeli**. Görünüyorsa dosyayı sil ve anahtarını Kedy panelinden yenile.

## 2. Render'da yayınla

1. render.com'da GitHub hesabınla kaydol.
2. **New +** → **Web Service** seç, GitHub deposunu (`phoenix-ai`) bağla.
3. Ayarlar:
   - **Runtime / Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free (varsa)
4. **Environment Variables** bölümünde **Add** de:
   - `KEDY_API_KEY` = kendi anahtarın
   - İstersen `RATE_LIMIT_PER_MIN` = `6` ve `DAILY_LIMIT` = `500`
5. **Create Web Service** de ve yayının bitmesini bekle.
6. Render sana `https://....onrender.com` ile biten bir adres verir. Bu adresi paylaşabilirsin.

## 3. Yayından sonra kontrol

- Adresi aç, bir mesaj gönder.
- `https://ADRESIN/health` adresi `{"ok":true}` göstermeli.
- Ücretsiz planlarda uygulama bir süre kullanılmayınca uyuyabilir; ilk açılış birkaç saniye yavaş olabilir. Jüri demosundan önce sayfayı bir kez açıp "ısıt".

## 4. Güvenlik özeti

- İstek sınırı: IP başına dakikada `RATE_LIMIT_PER_MIN` istek (varsayılan 6).
- Günlük toplam sınır: `DAILY_LIMIT` istek (varsayılan 500). Dolunca uygulama "yarın tekrar dene" der.
- Kedy panelinde harcama/kota limiti varsa ayrıca onu da ayarla.
- Anahtarın sızdığını düşünürsen Kedy panelinden yenile ve Render'daki değeri güncelle.
- Etkinlik bitince Render'da servisi **Suspend** veya **Delete** ederek kapat.
