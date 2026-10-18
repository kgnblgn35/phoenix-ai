# Ne Okusam? — Innovation Challenge Prototipi

Öğrencilerin ders, iş veya eğlence için ne okuyacağını/araştıracağını bulmasına yardım eden basit bir asistan.
Yapay zekâ: Kedy **NOVAQ** modeli (yalnızca backend üzerinden çağrılır).

## Kurulum

1. Node.js 18 veya üzeri kurulu olmalı (`node -v` ile kontrol et).
2. Bağımlılıkları kur:
   ```bash
   npm install
   ```
3. Ortam dosyasını oluştur:
   ```bash
   cp .env.example .env
   ```
   Windows (PowerShell): `copy .env.example .env`
4. `.env` dosyasını aç ve `KEDY_API_KEY` değerine kendi anahtarını yaz.
5. Çalıştır:
   ```bash
   npm start
   ```
6. Tarayıcıda `http://localhost:3000` adresini aç.

## Güvenlik

- API anahtarı yalnızca `.env` içinde durur; frontend kodunda yoktur.
- `.env` dosyası `.gitignore` ile Git'e eklenmez, `.env.example` ise örnek değer içerir.
- Tarayıcı yalnızca kendi sunucumuzdaki `/api/chat` adresine istek atar; Kedy API'sine sunucu ulaşır.

## Nasıl çalışır?

- Hedef kitle lise ve üniversite öğrencileri.
- Model kitap/makale adı uydurmak yerine **araştırma konusu + anahtar kelime** önerir.
- Sohbet geçmişi destekli: "daha kolay olsun", "başka öner" gibi devam soruları sorulabilir. Geçmiş tarayıcıda tutulur, sunucu her istekte son 12 mesajı modele iletir. "Yeni sohbet" butonu geçmişi sıfırlar.
- Enter ile gönderilir, Shift+Enter yeni satır ekler.
- Prototip yerelde çalışacak şekilde tasarlandı; internete açılacaksa istek sınırlaması (rate limit) eklenmelidir.

## Yapı

```
server.js         Express backend, Kedy API proxy'si
public/index.html Arayüz
public/style.css  Stil
public/app.js     Frontend mantığı (yükleniyor/hata/sonuç)
.env.example      Örnek ortam değişkenleri
```
