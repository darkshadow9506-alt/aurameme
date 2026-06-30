# 🚀 راه‌اندازی AuraMeme از صفر (مخصوص ایران + OpenVPN)

این راهنما قدم‌به‌قدم و دقیق، از هیچی تا یک رباتِ زنده‌ی تلگرام که سیگنال می‌ده.

> چون **OpenVPN** داری و کل سیستم رو از IP خارج رد می‌کنه، **نیازی به تنظیم `PROXY_URL` نداری**. فقط کافیه قبل از اجرا VPN وصل باشه.

---

## قدم ۰ — VPN رو وصل کن و مطمئن شو کار می‌کنه

۱. OpenVPN رو وصل کن (به یه سرور خارج از ایران، مثلاً آلمان/فنلاند/هلند).
۲. مطمئن شو IP عوض شده. یه مرورگر باز کن و برو:
   `https://ipinfo.io`  →  باید کشورِ **غیرِ ایران** نشون بده.

> ⚠️ مهم: تا وقتی ربات روشنه، VPN باید وصل بمونه. اگه VPN قطع شه، APIها (به‌خاطر تحریم) جواب نمی‌دن و سیگنال‌ها قطع می‌شن.

---

## قدم ۱ — نصب Node.js (نسخه ۲۰ یا بالاتر)

### ویندوز
۱. برو به `https://nodejs.org` و نسخه‌ی **LTS** رو دانلود و نصب کن (next, next, finish).
۲. **PowerShell** رو باز کن و چک کن:
```powershell
node --version
npm --version
```
باید مثلاً `v20.x` یا `v22.x` نشون بده.

### لینوکس / Ubuntu
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version
```

### مک
```bash
brew install node git
node --version
```

---

## قدم ۲ — گرفتن کد ربات

تو ترمینال/PowerShell، برو جایی که می‌خوای پروژه باشه و:
```bash
git clone https://github.com/darkshadow9506-alt/aurameme.git
cd aurameme
git checkout claude/brave-einstein-2aib9q
```
> اگه `git` نداری: ویندوز از `https://git-scm.com` نصب کن. لینوکس: `sudo apt install git`.

---

## قدم ۳ — نصب وابستگی‌ها

داخل پوشه‌ی `aurameme`:
```bash
npm install
```
چند ثانیه طول می‌کشه. (VPN باید وصل باشه.)

---

## قدم ۴ — ساختن ربات تلگرام و گرفتن توکن

۱. تو تلگرام برو پیش **@BotFather**.
۲. بزن `/newbot`.
۳. یه **اسم** بده (هرچی، مثل `My Aura Bot`).
۴. یه **یوزرنیم** بده که حتماً به `bot` ختم شه (مثل `my_aura_signals_bot`).
۵. BotFather یه **توکن** می‌ده، شبیه این:
   `7123456789:AAFx…………………`
   👈 این رو کپی کن و یه جا نگه‌دار (همینه `TELEGRAM_BOT_TOKEN`).

---

## قدم ۵ — گرفتن Chat ID خودت

۱. تو تلگرام برو پیش **@userinfobot** (یا `@RawDataBot`).
۲. بهش `/start` بزن یا یه پیام بده.
۳. یه عددی بهت می‌ده مثل `Id: 123456789`.
   👈 این عدد همون `TELEGRAM_CHAT_IDS` توئه. (سیگنال‌ها به همین‌جا میان.)

---

## قدم ۶ — (اختیاری ولی توصیه‌شده) کلید Helius

با کلید رایگان Helius، آنالیز هولدرها و تشخیص باندل **خیلی دقیق‌تر** می‌شه.

۱. برو `https://helius.dev` و یه اکانت رایگان بساز (با همون VPN).
۲. تو داشبورد، یه **API Key** بساز.
۳. کلید رو کپی کن. آدرس RPC کاملت می‌شه:
   `https://mainnet.helius-rpc.com/?api-key=کلیدت`

> اگه الان نمی‌خوای، رد شو — ربات با RPC عمومی هم کار می‌کنه، فقط محدودتر.

---

## قدم ۷ — ساختن فایل `.env`

تو پوشه‌ی `aurameme`، فایل نمونه رو کپی کن:

**ویندوز (PowerShell):**
```powershell
Copy-Item .env.example .env
notepad .env
```
**لینوکس/مک:**
```bash
cp .env.example .env
nano .env
```

حالا این چند خط رو پر کن (بقیه رو دست نزن):

```ini
# توکنی که BotFather داد
TELEGRAM_BOT_TOKEN=7123456789:AAFx……………

# Chat ID که userinfobot داد
TELEGRAM_CHAT_IDS=123456789

# اگه کلید Helius گرفتی، این دو خط رو بذار (وگرنه دست نزن):
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=کلیدت
HELIUS_API_KEY=کلیدت

# چون OpenVPN داری، این رو خالی بذار:
PROXY_URL=
```

ذخیره کن و ببند. (تو notepad: Ctrl+S. تو nano: Ctrl+O، Enter، Ctrl+X.)

---

## قدم ۸ — تست سریع قبل از اجرا (مهم)

اول مطمئن شو اتصالت درسته. یه توکن معروف رو آنالیز کن:
```bash
npm run scan -- DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```
- اگه یه گزارش با freeze/holders/… دیدی → **اتصالت درسته ✅**
- اگه `HTTP 403` دیدی → **VPN وصل نیست یا کشورش بلاکه** → VPN رو چک کن/سرور عوض کن.

---

## قدم ۹ — اجرای ربات

```bash
npm run dev
```
باید این‌ها رو ببینی:
```
[OK] (engine) engine started — listening for new pump.fun tokens
[OK] (telegram) Telegram bot @my_aura_signals_bot online
[OK] (web) dashboard at http://127.0.0.1:8787
[OK] (main) AuraMeme is live.
```

حالا:
- تو تلگرام برو پیش رباتِ خودت و بزن `/start` → باید جواب بده.
- داشبورد رو تو مرورگر باز کن: `http://127.0.0.1:8787`
- تست یه توکن: `/check <آدرس_توکن>`

ربات از همین الان توکن‌های جدید pump.fun رو رصد می‌کنه و وقتی سیگنال/ورود نهنگ/خروج دامپ پیش بیاد، بهت پیام می‌ده.

---

## قدم ۱۰ — همیشه روشن نگه داشتن (اختیاری)

`npm run dev` تا وقتی ترمینال بازه کار می‌کنه. اگه ترمینال رو ببندی، ربات می‌خوابه.
برای اینکه دائم بالا بمونه از **pm2** استفاده کن:

```bash
npm install -g pm2
npm run build
pm2 start dist/index.js --name aurameme
pm2 save
pm2 logs aurameme      # دیدن لاگ‌ها
```
- بعداً برای دیدن وضعیت: `pm2 status`
- ری‌استارت: `pm2 restart aurameme`
- خاموش: `pm2 stop aurameme`

> یادت باشه: کامپیوتر و VPN باید روشن بمونن. اگه می‌خوای ۲۴ ساعته و بدون دغدغه باشه، یه VPS خارج بگیر و همین قدم‌ها رو اونجا بزن (اونجا VPN هم نمی‌خواد).

---

## دستورهای تلگرام
```
/start        راهنما
/check <mint> آنالیز کامل یک توکن
/recent       آخرین توکن‌های آنالیزشده
/signals      سیگنال‌های اخیر
/positions    توکن‌هایی که زنده دنبال می‌شن
/wallets      کیف‌پول‌های smart money
/addwallet <addr> [نام]   اضافه‌کردن یه تریدر برنده
/help         نکات ریسک
```

---

## 🆘 اگه pumpportal بلاک بود (`ETIMEDOUT` روی pumpportal.fun)

اگه ربات بالا میاد ولی فقط `pumpportal` خطای `ETIMEDOUT` می‌ده (یعنی سرورِ VPNت اون رو بلاک کرده) و سرورِ VPN دیگه‌ای نداری، **منبعِ جایگزین** رو روشن کن که مستقیم از خودِ شبکه‌ی Solana می‌خونه:

۱. مطمئن شو RPCت در دسترسه (ترجیحاً **Helius**):
```powershell
Test-NetConnection mainnet.helius-rpc.com -Port 443    # باید True باشه
```
۲. تو `.env` این‌ها رو بذار:
```ini
FEED_SOURCE=solana
HELIUS_API_KEY=کلیدت
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=کلیدت
```
۳. دوباره `npm run dev`. حالا باید این رو ببینی:
```
[INFO] (feed) feed source: solana program logs (direct RPC)
[OK] (solana-logs) connected — subscribing to pump.fun program logs
[OK] (solana-logs) subscription active (id …)
```
این روش به pumpportal نیازی نداره و فقط به یه RPCِ در دسترس وصله.

> **چرا Helius؟** این روش حجمِ بالایی از لاگ‌ها رو می‌گیره؛ RPC عمومی (`api.mainnet-beta`) ممکنه `403` بده یا قطع‌وصل بشه. Helius رایگانه و پایدار.

---

## مشکلات رایج

| مشکل | علت / راه‌حل |
|---|---|
| `pumpportal ETIMEDOUT` | سرورِ VPNت اون رو بلاک کرده → یا سرور VPN عوض کن، یا `FEED_SOURCE=solana` بذار (بالا👆) |
| `HTTP 403` تو لاگ | VPN وصل نیست یا سرورش بلاکه → VPN رو وصل/عوض کن |
| ربات تو تلگرام جواب نمی‌ده | توکن غلطه، یا VPN قطعه → `.env` و VPN رو چک کن |
| `Telegram failed to start` | `TELEGRAM_BOT_TOKEN` اشتباهه → از BotFather دوباره بگیر |
| سیگنال کم میاد | طبیعیه؛ آستانه بالاست. تو `.env` می‌تونی `SIGNAL_MIN_SCORE` رو کم کنی |
| `node` شناخته نمی‌شه | Node نصب نشده یا ترمینال رو نبستی‌وباز نکردی |

---

## ⚠️ یادآوری
میم‌کوین قمارگونه و فوق‌العاده پرریسکه. این ربات شانس رو بهتر می‌کنه، **تضمین سود نیست**. فقط با پولی که از دستش بدی زندگی‌ت بهم نریزه.
