Ти працюєш у NestJS/Prisma/Telegraf проєкті `stock-sniper-ua`. Потрібно пофіксити прогалини по навантаженню, abuse-захисту та стабільності. Роби зміни поступово, окремими задачами. Після кожної задачі запускай релевантні тести або хоча б `npm test` / `npm run build`, якщо тести недоступні. Не ламай існуючу логіку Telegram-бота.

№1 Пофіксити валідацію URL у scraper
Проблема: зараз підтримуваний магазин перевіряється regex-ом по всьому рядку URL, тому можна підсунути URL типу `https://comfy.ua@evil.example/` або URL з `comfy.ua` у query/path.
Що зробити:
- У `src/scraper/scraper.service.ts` парсити URL через `new URL(url)`.
- Перевіряти саме `hostname`, а не весь URL.
- Дозволяти тільки реальні домени підтримуваних магазинів і їх піддомени, якщо це потрібно.
- Заборонити userinfo в URL (`username` / `password`), нестандартні протоколи, локальні/приватні IP, `localhost`.
- Додати unit-тести на:
  - валідний URL магазину;
  - `https://comfy.ua@evil.example/`;
  - `https://evil.example/?next=comfy.ua`;
  - `http://localhost/...`;
  - приватні IP типу `http://127.0.0.1/...`.

№2 Додати нормалізацію URL перед збереженням і перевіркою дублікатів
Проблема: один і той самий товар може бути доданий кілька разів через різні варіанти URL.
Що зробити:
- Створити helper для нормалізації URL.
- Мінімум: lower-case hostname, прибрати hash, прибрати зайві tracking query params (`utm_*`, `fbclid`, `gclid` тощо), нормалізувати trailing slash.
- У `processUrl()` використовувати normalized URL для `findByUrl()` і `addItem()`.
- Не змінювати URL так агресивно, щоб ламались товарні сторінки магазинів.

№3 Додати DB-level захист від дублікатів товарів
Проблема: зараз `findByUrl()` + `addItem()` має race condition, бо в Prisma schema немає унікального constraint.
Що зробити:
- У `prisma/schema.prisma` додати унікальність на активний товар користувача. Якщо Prisma/Postgres partial unique index складно описати в schema, додати raw SQL migration.
- Бажаний варіант: унікальний індекс для `(userId, url)` тільки для `isActive = true`, якщо підтримується через migration.
- У `ItemsService.addItem()` коректно обробляти помилку унікальності і повертати зрозумілий результат/помилку.
- Оновити тести, щоб одночасне додавання одного URL не створювало дубль.

✅ №4 Посилити rate limiting для Telegram callback/action handler-ів
Проблема: rate limit стоїть переважно на `@On("text")`, але `@Action(...)` handler-и теж можуть створювати DB/API навантаження.
Що зробити:
- Додати reusable guard/helper, наприклад `ensureRateLimited(ctx, type)`.
- Застосувати його до callback handler-ів: delete item, list products, target price actions, tariff/shop actions, delete data confirmation/cancel.
- Для легких callback-ів можна використати `default`, для важчих `scrape` або окремий тип `action`.
- Якщо користувач перевищив ліміт, відповідати через `ctx.answerCbQuery(...)`, а не спамити чат повідомленнями.

№5 Зробити rate limiter стійкішим до навантаження
Проблема: поточний limiter in-memory, per-process, скидається після рестарту і не працює між кількома інстансами.
Що зробити:
- Мінімальний варіант: додати global ліміти у поточний in-memory limiter: наприклад `scrapeGlobal` на всі scrape-запити за хвилину.
- Кращий варіант: винести rate limit у Redis/Upstash, якщо у проєкті вже є або планується Redis.
- Не блокувати критичні системні задачі, тільки user-triggered запити.
- Додати тести на per-user і global ліміти.

№6 Обмежити кількість due-items за один sniper cycle
Проблема: `getItemsDueForCheck()` може повернути дуже багато товарів, а `runSniper()` обробляє їх послідовно до timeout.
Що зробити:
- Додати `limit` у `getItemsDueForCheck(limit = ...)`.
- В SQL додати `LIMIT`.
- У `SnipeService` задати константу, наприклад `MAX_ITEMS_PER_CYCLE`.
- Логувати, скільки items взято в роботу.
- Не намагатися обробити всю базу за один тік.

№7 Перевести scheduler на `nextCheckAt`
Проблема: у schema є `nextCheckAt`, але hot path використовує `lastCheckedAt + interval`, що гірше індексується.
Що зробити:
- У `getItemsDueForCheck()` фільтрувати по `nextCheckAt <= NOW()`.
- У `updateItemPrice()` після перевірки виставляти новий `nextCheckAt = now + checkIntervalMinutes`.
- При помилках scraping теж оновлювати `lastCheckedAt` / `nextCheckAt`, щоб один проблемний товар не крутився безкінечно щохвилини.
- Додати індекс у Prisma schema: `@@index([isActive, isFrozen, nextCheckAt])`.
- Додати migration.

№8 Додати backoff для проблемних товарів
Проблема: якщо магазин блокує або URL битий, товар може створювати постійне навантаження.
Що зробити:
- Використати існуюче поле `consecutiveErrors`.
- При успішному scrape скидати `consecutiveErrors = 0`.
- При помилці збільшувати `consecutiveErrors`.
- Для помилок ставити більший `nextCheckAt`, наприклад:
  - 1 помилка: стандартний інтервал;
  - 2-3 помилки: +6 годин;
  - 4+ помилки: +24 години або `isFrozen = true`, якщо це відповідає продукту.
- Логувати такі випадки без витоку повного URL, якщо можливо.

№9 Захистити HTML output від небезпечного контенту
Проблема: назва товару зі scraped HTML вставляється в `replyWithHTML` / HTML formatted messages.
Що зробити:
- Перевірити всі місця, де `item.title`, `scraped.title`, username або інші зовнішні дані вставляються у HTML.
- Додати helper `escapeHtml()`.
- Використовувати його у `bot.utils.ts` та повідомленнях, де є зовнішній текст.
- Додати тести на title типу `<b>fake</b>` або `<a href="...">click</a>`.

№10 Зменшити ризик спаму Telegram API
Проблема: `onList()` відправляє окреме повідомлення на кожен товар. Якщо ліміти виростуть, це може створити burst у Telegram API.
Що зробити:
- Для маленьких лімітів залишити як є або додати невелику затримку.
- Для більших списків обмежити page size, наприклад 5-10 товарів на сторінку.
- Додати inline pagination: `list_page:0`, `list_page:1`.
- Rate-limit callback pagination.

№11 Покращити observability для Railway
Проблема: при навантаженні складно буде зрозуміти, що саме болить.
Що зробити:
- Додати структуровані логи для:
  - start/end sniper cycle;
  - кількість due items;
  - кількість successful/failed scrape;
  - timeout cycle;
  - rate limit exceeded;
  - duplicate URL rejected;
  - scraper HTTP status buckets.
- Не логувати повні Telegram IDs і чутливі дані. Використовувати internal user id або masked id.

№12 Перевірити Railway deployment assumptions
Проблема: проєкт працює як always-on Telegram polling + in-process Nest cron.
Що зробити:
- Додати короткий `DEPLOYMENT.md` або секцію в README:
  - для поточної архітектури потрібен always-on процес;
  - Railway Hobby підходить краще за Free;
  - не запускати кілька replicas з polling без переходу на webhook, інакше Telegram polling може конфліктувати;
  - Railway cron jobs не є заміною long-running bot polling.
- Додати health endpoint, якщо його немає, наприклад `/health`, щоб Railway/людина могла перевірити, що сервіс живий.

Фінальна перевірка:
- Запусти `npm test`.
- Запусти `npm run build`.
- Перевір, що Prisma migration створюється і застосовується.
- У фінальному звіті коротко вкажи, які задачі виконані, які файли змінені, і які ризики залишились.