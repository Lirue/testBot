# 📚 Book Stock Bot (GitHub Actions + Discord)

Bot automatycznie sprawdzający dostępność wybranych książek (zarówno zwykły zakup **Add to basket**, jak i **Pre-order**). Działa całkowicie w chmurze dzięki **GitHub Actions** (co 20 minut) i wysyła powiadomienia na **Discorda**.

Wszystkie wrażliwe dane (adresy URL obserwowanych książek oraz adres Webhooka Discord) są przechowywane prywatnie w **GitHub Secrets** i nie są widoczne w publicznym kodzie ani w logach.

---

## 🔍 Jak działa wykrywanie dostępności?

Skrypt (`check-stock.js`) analizuje stronę produktu dwutorowo na podstawie struktury HTML:
1. **Przyciski i kontenery HTML (`.book-actions`)**:
   - **Dostępna (`BUY_AVAILABLE` / `PREORDER_AVAILABLE`)**: obecny przycisk `<button data-testid="add-to-basket" class="button button-teal button-buy">Add to basket</button>` lub `Pre-order` oraz brak klasy `unavailable` na `.buy-container`.
   - **Niedostępna (`UNAVAILABLE`)**: obecny kontener `<div class="buy-container unavailable">`, blok `<div class="detail-out-of-stock">` oraz przycisk `Notify me` (`.button-notify`).
2. **Dane strukturalne Schema.org (`<script type="application/ld+json">`)**:
   - Sprawdza pole `offers.availability`:
     - `https://schema.org/InStock` → **Dostępna**
     - `https://schema.org/PreOrder` → **Dostępna (Pre-order)**
     - `https://schema.org/OutOfStock` → **Niedostępna**

---

## 🚀 Instrukcja uruchomienia krok po kroku

### Krok 1: Utwórz Webhook na swoim serwerze Discord
1. Otwórz aplikację **Discord** i wejdź na swój serwer (lub utwórz własny, prywatny serwer tylko dla siebie).
2. Kliknij ikonę koła zębatego (**Edytuj kanał**) przy kanale tekstowym, na którym chcesz otrzymywać powiadomienia.
3. Przejdź do zakładki **Integracje** (`Integrations`) → **Webhooki** (`Webhooks`) → **Nowy webhook** (`New Webhook`).
4. Kliknij **Kopiuj adres URL webhooka** (`Copy Webhook URL`).

### Krok 2: Wrzuć projekt do repozytorium na GitHubie
1. Utwórz nowe repozytorium na swoim koncie GitHub.
2. Wrzuć pliki z tego folderu (`package.json`, `check-stock.js`, `.gitignore` oraz `.github/workflows/stock-bot.yml`) do swojego repozytorium.

### Krok 3: Dodaj prywatne sekrety (`DISCORD_WEBHOOK_URL` oraz `BOOK_URLS`)
1. W swoim repozytorium na GitHubie wejdź w zakładkę **Settings** (u góry).
2. W menu po lewej stronie wybierz **Secrets and variables** → **Actions**.
3. Kliknij **New repository secret** i dodaj pierwszy sekret:
   - **Name:** `DISCORD_WEBHOOK_URL`
   - **Secret:** *(wklej skopiowany link Webhooka z Discorda)*
4. Kliknij ponownie **New repository secret** i dodaj drugi sekret z linkami do książek:
   - **Name:** `BOOK_URLS`
   - **Secret:** *(wklej jeden lub więcej linków – każdy w nowej linii lub po przecinku)*

### Krok 4: Przetestuj bota jednym kliknięciem!
1. Wejdź w zakładkę **Actions** w swoim repozytorium na GitHubie.
2. Po lewej stronie kliknij **Book Stock Bot**.
3. Po prawej stronie kliknij przycisk **Run workflow**, zmień opcję na **`true`** (wyślij testowe powiadomienie) i zatwierdź zielonym przyciskiem **Run workflow**.
4. Po około minucie dostaniesz testową wiadomość z kartą książki na swój kanał Discord! Od tej pory bot będzie sam sprawdzał dostępność co 20 minut.

---

## 🧪 Testowanie lokalne (opcjonalnie)

Jeśli masz w folderze zapisane lokalne pliki HTML (`preorder-available.html`, `buy-available.html`, `notify-me.html`), możesz przetestować parser komendą:

```bash
npm run test-local
```

