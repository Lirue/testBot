const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '.stock-state.json');

/**
 * Parsuje kod HTML strony produktu i zwraca szczegółowe informacje o dostępności.
 * Wykorzystuje zarówno dane strukturalne JSON-LD (schema.org), jak i selektory HTML przycisku zakupu.
 */
function parseProductHtml(html, fallbackUrl = '') {
  // Sprawdzenie, czy strona nie jest blokadą Cloudflare ("Just a moment...")
  const isCloudflareChallenge =
    (html.includes('<title>Just a moment...</title>') ||
      html.includes('cf-browser-verification') ||
      html.includes('challenge-platform')) &&
    !html.includes('scope_book_title') &&
    !html.includes('book-actions');

  if (isCloudflareChallenge) {
    return {
      blockedByCloudflare: true,
      available: false,
      statusType: 'CLOUDFLARE_BLOCKED',
      buyButtonText: 'Zablokowano (Cloudflare)',
      schemaAvailability: 'Brak',
      reason: 'Strona zwróciła ekran weryfikacji Cloudflare (Just a moment...)'
    };
  }

  let ldProduct = null;
  let ldBook = null;

  // 1. Wyciągnięcie danych z <script type="application/ld+json">
  const ldJsonRegex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = ldJsonRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const graph = parsed['@graph'] || (Array.isArray(parsed) ? parsed : [parsed]);
      for (const item of graph) {
        if (item['@type'] === 'Product') ldProduct = item;
        if (item['@type'] === 'Book') ldBook = item;
      }
    } catch (_) {
      // Ignoruj niepoprawne bloki JSON-LD
    }
  }

  // 2. Sprawdzenie sygnałów w drzewie HTML (przyciski i kontenery)
  const buyButtonMatch =
    html.match(/<button[^>]*data-testid=["']add-to-basket["'][^>]*>([\s\S]*?)<\/button>/i) ||
    html.match(/<button[^>]*class=["'][^"']*button-buy[^"']*["'][^>]*>([\s\S]*?)<\/button>/i);
  const buyButtonText = buyButtonMatch ? buyButtonMatch[1].replace(/<[^>]+>/g, '').trim() : null;

  // Kontener niedostępności
  const hasUnavailableContainer = /<div[^>]*class=["'][^"']*buy-container\s+unavailable[^"']*["']/i.test(html);
  const hasOutOfStockBlock = /<div[^>]*class=["'][^"']*detail-out-of-stock[^"']*["']/i.test(html);
  const hasNotifyButton = /<button[^>]*class=["'][^"']*button-notify[^"']*["']/i.test(html);

  // Informacja o stanie magazynowym np. <span id="scope_offer_availability">10+ in stock</span> lub "Coming soon"
  const stockBadgeMatch = html.match(/<span[^>]*id=["']scope_offer_availability["'][^>]*>([\s\S]*?)<\/span>/i);
  const stockBadgeText = stockBadgeMatch ? stockBadgeMatch[1].replace(/<[^>]+>/g, '').trim() : null;

  // Tytuł z HTML: <span class="book-title" id="scope_book_title">...</span>
  const titleMatch = html.match(/id=["']scope_book_title["'][^>]*>([\s\S]*?)<\/span>/i);
  const htmlTitle = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim()) : null;

  // Cena z HTML: <div class="price">...<b>£25.00</b>
  const priceMatch = html.match(/<div\s+class=["']price["'][\s\S]*?<b>([\s\S]*?)<\/b>/i);
  const htmlPrice = priceMatch ? decodeHtmlEntities(priceMatch[1].replace(/<[^>]+>/g, '').trim()) : null;

  // Dane z JSON-LD
  const schemaAvailability = ldProduct?.offers?.availability || null;
  const title = htmlTitle || ldProduct?.name || ldBook?.name || 'Nieznany tytuł';
  const author = ldBook?.author?.name || null;
  const isbn = ldBook?.isbn || ldProduct?.sku || ldProduct?.gtin13 || null;
  const image = ldProduct?.image || ldBook?.image || null;
  const url = ldProduct?.url || ldBook?.url || fallbackUrl;
  const price = ldProduct?.offers?.price
    ? `${ldProduct.offers.price} ${ldProduct.offers.priceCurrency || 'GBP'}`
    : htmlPrice || 'Brak danych';

  // 3. Logika decyzyjna dostępności
  const isSchemaAvailable =
    schemaAvailability === 'https://schema.org/InStock' ||
    schemaAvailability === 'https://schema.org/PreOrder' ||
    schemaAvailability === 'http://schema.org/InStock' ||
    schemaAvailability === 'http://schema.org/PreOrder';

  const isSchemaOutOfStock =
    schemaAvailability === 'https://schema.org/OutOfStock' ||
    schemaAvailability === 'http://schema.org/OutOfStock';

  const hasBuyButton = Boolean(buyButtonText);
  const isDomUnavailable = hasUnavailableContainer || hasOutOfStockBlock || (hasNotifyButton && !hasBuyButton);

  // Produkt jest dostępny, jeśli ma przycisk zakupu ("Add to basket" / "Pre-order") lub schema InStock/PreOrder i nie ma blokady niedostępności
  const available = (hasBuyButton || isSchemaAvailable) && !isDomUnavailable;

  let statusType = 'UNAVAILABLE';
  if (available) {
    if (
      (buyButtonText && /pre-?order/i.test(buyButtonText)) ||
      schemaAvailability?.endsWith('/PreOrder')
    ) {
      statusType = 'PREORDER_AVAILABLE';
    } else {
      statusType = 'BUY_AVAILABLE';
    }
  } else if (!isSchemaOutOfStock && !isDomUnavailable && !ldProduct && !htmlTitle) {
    statusType = 'UNKNOWN_PAGE_STRUCTURE';
  }

  return {
    blockedByCloudflare: false,
    available,
    statusType,
    title,
    author,
    isbn,
    price,
    url,
    image,
    buyButtonText: buyButtonText || (hasNotifyButton ? 'Notify me' : 'Brak przycisku'),
    stockBadgeText: stockBadgeText || (hasOutOfStockBlock ? 'Notify me when available' : null),
    schemaAvailability
  };
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&pound;/g, '£');
}

/**
 * Pobiera listę linków ze zmiennej środowiskowej BOOK_URLS (GitHub Secret).
 * Obsługuje: pojedynczy link, linki oddzielone nową linią lub przecinkiem, albo tablicę JSON.
 */
function getBookUrls() {
  const raw = (process.env.BOOK_URLS || '').trim();
  if (!raw) {
    throw new Error(
      'Brak skonfigurowanych linków! Dodaj sekret BOOK_URLS w ustawieniach GitHub (Settings -> Secrets and variables -> Actions).'
    );
  }

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((u) => String(u).trim()).filter(Boolean);
      }
    } catch (_) {
      // Jeśli to nie poprawny JSON, podziel po liniach/przecinkach poniżej
    }
  }

  return raw
    .split(/[\r\n,]+/)
    .map((u) => u.trim())
    .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
}

let sharedBrowserContext = null;
let sharedBrowserInstance = null;
let forceBrowserMode = false;

/**
 * Tworzy (lub zwraca istniejący) kontekst przeglądarki odporny na detekcję Cloudflare Turnstile.
 * Używa "patchright" (jeśli dostępny) bez sztucznego nadpisywania User-Agent (aby uniknąć konfliktu Windows UA vs Linux navigator.platform).
 */
async function getBrowserContext() {
  if (sharedBrowserContext) {
    return sharedBrowserContext;
  }

  let pw;
  try {
    pw = require('patchright');
  } catch (_) {
    try {
      pw = require('playwright');
    } catch (__) {
      throw new Error(
        'Zwykłe zapytanie zostało zablokowane, a pakiet "patchright" / "playwright" nie jest zainstalowany. Uruchom: npm install'
      );
    }
  }

  const useHeaded = process.env.PLAYWRIGHT_HEADLESS === 'false';
  const userDataDir = path.join(__dirname, '.browser-profile');

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--window-size=1366,768'
  ];

  const contextOptions = {
    headless: !useHeaded,
    args: launchArgs,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1366, height: 768 }
  };

  try {
    sharedBrowserContext = await pw.chromium.launchPersistentContext(userDataDir, {
      ...contextOptions,
      channel: 'chrome'
    });
  } catch (_) {
    try {
      sharedBrowserContext = await pw.chromium.launchPersistentContext(userDataDir, contextOptions);
    } catch (__) {
      sharedBrowserInstance = await pw.chromium.launch({
        headless: !useHeaded,
        args: launchArgs
      });
      sharedBrowserContext = await sharedBrowserInstance.newContext({
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        viewport: { width: 1366, height: 768 }
      });
    }
  }

  return sharedBrowserContext;
}

async function closeBrowserContext() {
  try {
    if (sharedBrowserContext) {
      await sharedBrowserContext.close();
      sharedBrowserContext = null;
    }
    if (sharedBrowserInstance) {
      await sharedBrowserInstance.close();
      sharedBrowserInstance = null;
    }
  } catch (_) {}
}

/**
 * Próbuje rozwiązać (kliknąć) widget Cloudflare Turnstile ("Verify you are human"),
 * jeśli strona wyświetla ekran "Just a moment...".
 */
async function waitAndSolveCloudflare(page, maxWaitMs = 35000) {
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    // Sprawdź, czy docelowa zawartość strony jest już widoczna
    const hasProductContent = await page
      .locator('#scope_book_title, .book-actions')
      .first()
      .isVisible()
      .catch(() => false);

    if (hasProductContent) {
      return true;
    }

    const title = await page.title().catch(() => '');
    const content = await page.content().catch(() => '');
    const isCf =
      title.includes('Just a moment') ||
      content.includes('cf-browser-verification') ||
      content.includes('challenge-platform');

    if (!isCf && content.includes('scope_book_title')) {
      return true;
    }

    // Szukamy współrzędnych widgetu Cloudflare Turnstile, aby kliknąć pole wyboru
    try {
      const clickTarget = await page.evaluate(() => {
        // 1. Sprawdź widoczne iframe Cloudflare
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          const rect = iframe.getBoundingClientRect();
          if (rect.width >= 200 && rect.height >= 40) {
            return { x: rect.left + 30, y: rect.top + rect.height / 2 };
          }
        }

        // 2. Sprawdź kontenery Turnstile na stronie "Just a moment..." (nawet z zamkniętym Shadow DOM)
        const candidates = Array.from(
          document.querySelectorAll(
            '#turnstile-wrapper, .cf-turnstile, #challenge-stage, .main-content div'
          )
        );
        for (const el of candidates) {
          const rect = el.getBoundingClientRect();
          if (rect.width >= 250 && rect.width <= 420 && rect.height >= 50 && rect.height <= 95) {
            return { x: rect.left + 30, y: rect.top + rect.height / 2 };
          }
        }
        return null;
      });

      if (clickTarget) {
        const jitterX = clickTarget.x + (Math.random() * 6 - 3);
        const jitterY = clickTarget.y + (Math.random() * 6 - 3);
        await page.mouse.move(jitterX, jitterY, { steps: 12 });
        await page.waitForTimeout(150);
        await page.mouse.click(jitterX, jitterY);
      } else {
        // Delikatny ruch myszą na stronie, aby aktywować weryfikację Turnstile
        await page.mouse.move(220 + Math.random() * 100, 280 + Math.random() * 60, { steps: 8 });
      }
    } catch (_) {}

    await page.waitForTimeout(2500);
  }

  return false;
}

/**
 * Pobiera kod HTML strony produktu.
 * Najpierw próbuje szybkiego zapytania fetch, a jeśli Cloudflare zablokuje ruch,
 * automatycznie uruchamia przeglądarkę (z zachowaniem sesji i obsługą Turnstile).
 */
async function fetchProductHtml(url) {
  if (!forceBrowserMode) {
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-GB,en;q=0.9,pl-PL;q=0.8,pl;q=0.7',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Linux"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    };

    try {
      const response = await fetch(url, { headers, redirect: 'follow' });
      const html = await response.text();
      const check = parseProductHtml(html, url);

      if (response.ok && !check.blockedByCloudflare && check.statusType !== 'UNKNOWN_PAGE_STRUCTURE') {
        return html;
      }
      console.log(
        `[INFO] Zwykłe zapytanie HTTP zwróciło status ${response.status} (${check.statusType}). Przełączam na przeglądarkę...`
      );
      forceBrowserMode = true;
    } catch (err) {
      console.log(`[INFO] Błąd zwykłego zapytania HTTP. Przełączam na przeglądarkę...`);
      forceBrowserMode = true;
    }
  }

  const context = await getBrowserContext();
  const existingPages = context.pages();
  const page = existingPages.length > 0 ? existingPages[0] : await context.newPage();

  await page.bringToFront().catch(() => {});
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await waitAndSolveCloudflare(page, 35000);
  return await page.content();
}

/**
 * Wysyła powiadomienie na Discord przez Webhook.
 */
async function sendDiscordNotification(webhookUrl, bookInfo, isTest = false) {
  const isPreorder = bookInfo.statusType === 'PREORDER_AVAILABLE';
  const statusLabel = isPreorder
    ? '🟡 PRE-ORDER DOSTĘPNY'
    : bookInfo.available
    ? '🟢 DOSTĘPNA DO ZAKUPU (In Stock)'
    : '🔴 NIEDOSTĘPNA (Test powiadomienia)';

  const embedColor = bookInfo.available ? (isPreorder ? 0xf59e0b : 0x10b981) : 0xef4444;

  const fields = [
    { name: 'Status', value: statusLabel, inline: true },
    { name: 'Przycisk na stronie', value: `\`${bookInfo.buyButtonText}\``, inline: true },
    { name: 'Cena', value: bookInfo.price || 'Brak danych', inline: true }
  ];

  if (bookInfo.author) {
    fields.push({ name: 'Autor', value: bookInfo.author, inline: true });
  }
  if (bookInfo.isbn) {
    fields.push({ name: 'ISBN', value: bookInfo.isbn, inline: true });
  }
  if (bookInfo.stockBadgeText) {
    fields.push({ name: 'Informacja ze strony', value: bookInfo.stockBadgeText, inline: true });
  }

  const payload = {
    content: bookInfo.available
      ? `📚 **Książka "${bookInfo.title}" jest już dostępna!**\n🔗 ${bookInfo.url}`
      : `🔔 **Test bota** dla książki "${bookInfo.title}"`,
    embeds: [
      {
        title: bookInfo.title,
        url: bookInfo.url,
        color: embedColor,
        fields,
        thumbnail: bookInfo.image ? { url: bookInfo.image } : undefined,
        footer: {
          text: isTest ? 'Book Stock Bot • Powiadomienie testowe' : 'Book Stock Bot'
        },
        timestamp: new Date().toISOString()
      }
    ]
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Błąd wysyłania na Discord Webhook (${res.status}): ${errText}`);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Tryb testowy na 3 lokalnych plikach HTML
 */
function runLocalTests() {
  const testFiles = [
    { file: 'preorder-available.html', expectedAvailable: true, expectedType: 'PREORDER_AVAILABLE' },
    { file: 'buy-available.html', expectedAvailable: true, expectedType: 'BUY_AVAILABLE' },
    { file: 'notify-me.html', expectedAvailable: false, expectedType: 'UNAVAILABLE' }
  ];

  console.log('=== TESTOWANIE PARSERA NA LOKALNYCH PLIKACH HTML ===\n');
  let allPassed = true;

  for (const t of testFiles) {
    const filePath = path.join(__dirname, t.file);
    if (!fs.existsSync(filePath)) {
      console.log(`[POMINIĘTO] Brak pliku ${t.file}`);
      continue;
    }

    const html = fs.readFileSync(filePath, 'utf8');
    const result = parseProductHtml(html);

    const passed = result.available === t.expectedAvailable && result.statusType === t.expectedType;
    if (!passed) allPassed = false;

    console.log(`Plik: ${t.file}`);
    console.log(`  Tytuł:             ${result.title}`);
    console.log(`  Autor:             ${result.author}`);
    console.log(`  Cena:              ${result.price}`);
    console.log(`  Przycisk:          "${result.buyButtonText}"`);
    console.log(`  Komunikat stanu:   "${result.stockBadgeText}"`);
    console.log(`  Schema.org:        ${result.schemaAvailability}`);
    console.log(`  Wykryty status:    ${result.statusType} (dostępna: ${result.available})`);
    console.log(`  Wynik testu:       ${passed ? '✅ SUKCES' : '❌ BŁĄD'}\n`);
  }

  if (!allPassed) {
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--test-local')) {
    runLocalTests();
    return;
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  const forceTestNotification = process.env.SEND_TEST_NOTIFICATION === 'true' || args.includes('--force-notify');
  const alwaysNotifyWhenAvailable = process.env.ALWAYS_NOTIFY !== 'false';

  const books = getBookUrls();
  const prevState = loadState();
  const nextState = { ...prevState };

  console.log(`Sprawdzam dostępność ${books.length} pozycji...\n`);

  try {
    for (let i = 0; i < books.length; i++) {
      const bookUrl = books[i];
      const itemLabel = `Pozycja #${i + 1}`;
      console.log(`-> Sprawdzam: ${itemLabel}`);

      const html = await fetchProductHtml(bookUrl);
      const info = parseProductHtml(html, bookUrl);

      console.log(`   Status:   ${info.statusType} (dostępna: ${info.available})`);
      console.log(`   Przycisk: ${info.buyButtonText} | Schema: ${info.schemaAvailability}`);

      if (info.blockedByCloudflare || info.statusType === 'UNKNOWN_PAGE_STRUCTURE') {
        console.warn(`   ⚠️ Uwaga: Nie udało się jednoznacznie odczytać strony (${info.statusType}).`);
        continue;
      }

      const wasAvailableBefore = prevState[bookUrl]?.available === true;
      nextState[bookUrl] = {
        available: info.available,
        statusType: info.statusType,
        checkedAt: new Date().toISOString()
      };

      const shouldNotify =
        forceTestNotification ||
        (info.available && (alwaysNotifyWhenAvailable || !wasAvailableBefore));

      if (shouldNotify) {
        if (!webhookUrl) {
          console.log('   ℹ️ Pozycja dostępna (lub wymuszono test), ale brak zmiennej DISCORD_WEBHOOK_URL.');
        } else {
          await sendDiscordNotification(webhookUrl, info, forceTestNotification && !info.available);
          console.log('   ✅ Wysłano powiadomienie na Discord!');
        }
      } else {
        console.log('   ℹ️ Pozycja niedostępna – brak powiadomienia.');
      }
    }
  } finally {
    await closeBrowserContext();
  }

  saveState(nextState);
}

main().catch((err) => {
  console.error('❌ Błąd działania bota:', err);
  process.exit(1);
});
