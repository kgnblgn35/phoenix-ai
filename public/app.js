const form = document.getElementById("form");
const input = document.getElementById("message");
const sendBtn = document.getElementById("send");
const count = document.getElementById("count");
const loading = document.getElementById("loading");
const errorBox = document.getElementById("error");
const chat = document.getElementById("chat");
const chips = document.getElementById("chips");
const resetBtn = document.getElementById("reset");

// Sohbet geçmişi (sayfa yenilenince sıfırlanır)
let history = [];

input.addEventListener("input", () => {
  count.textContent = `${input.value.length} / 1000`;
});

// Enter ile gönder, Shift+Enter ile yeni satır
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    input.value = chip.dataset.text;
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
});

resetBtn.addEventListener("click", () => {
  history = [];
  chat.replaceChildren();
  chat.hidden = true;
  chips.hidden = false;
  resetBtn.hidden = true;
  errorBox.hidden = true;
  input.value = "";
  input.dispatchEvent(new Event("input"));
  input.focus();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  errorBox.hidden = true;

  if (!message) {
    showError("Lütfen önce bir şeyler yaz.");
    return;
  }

  history.push({ role: "user", content: message });
  addBubble("user", message);
  input.value = "";
  input.dispatchEvent(new Event("input"));
  chips.hidden = true;
  resetBtn.hidden = false;

  sendBtn.disabled = true;
  loading.hidden = false;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Başarısız isteği geçmişten çıkar, mesaj kutusuna geri koy
      history.pop();
      chat.lastElementChild?.remove();
      input.value = message;
      input.dispatchEvent(new Event("input"));
      showError(data.error || "Bir sorun oluştu. Lütfen tekrar dene.");
      return;
    }
    history.push({ role: "assistant", content: data.reply });
    addBubble("assistant", data.reply);
  } catch {
    history.pop();
    chat.lastElementChild?.remove();
    input.value = message;
    input.dispatchEvent(new Event("input"));
    showError("Sunucuya ulaşılamadı. İnternet bağlantını kontrol et.");
  } finally {
    loading.hidden = true;
    sendBtn.disabled = false;
    input.focus();
  }
});

function addBubble(role, text) {
  chat.hidden = false;
  const div = document.createElement("div");
  div.className = `bubble ${role}`;
  // textContent kullanıyoruz: model çıktısı HTML olarak yorumlanmaz
  div.textContent = text;
  chat.appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
}

function showError(text) {
  errorBox.textContent = text;
  errorBox.hidden = false;
}
