# כניסה לעורך האתר עם Google

עורך האתר (`/admin/`) מתחבר עם חשבון Google. שרת קטן וחינמי ב־Cloudflare (הקוד ב־`worker.mjs`) בודק שהמייל מורשה,
ורק אז מקבל את השינויים. מפתח ה־GitHub נשמר רק בשרת, והעורכים לא רואים אותו.

- **שמירה ופרסום נפרדים.** שמירה היא טיוטה במסד D1 (`heichal-cms`, הטבלאות נוצרות לבד): האתר לא משתנה. פרסום הוא קומיט אחד
  לענף הפרסום, ורק בעלי האתר ועורכים שסומנו "מפרסם" יכולים לעשות אותו. אפשר לפרסם חלק מהטיוטות, לבטל טיוטה, ולשחזר גרסה קודמת (כטיוטה).
- **יומן פעילות** (מי שמר, פרסם, ביטל או שחזר מה ומתי) נשמר ב־D1 עם כתובות המייל; הוא גלוי למפרסמים, וכתובות המייל רק לבעלי האתר.
  בהודעות הקומיט הציבוריות מופיעים רק שמות התצוגה שהעורכים בחרו.
- **בלי מיזוג אוטומטי:** אם שני עורכים שומרים את אותו קובץ, השני מקבל הודעה שהקובץ השתנה, והטקסט שהקליד נשמר בדפדפן שלו.

- **בעלי האתר** (רשומים ב־`OWNERS` ב־`wrangler.toml`, כגיבוב של המייל) נכנסים תמיד, ורק הם רואים את המסך "ניהול עורכים".
- **עורכים** נוספים ומוסרים מתוך העורך, במסך "ניהול עורכים". הרשימה נשמרת ב־Cloudflare (KV בשם `heichal-cms-editors`)
  ולא במאגר, כי המאגר ציבורי.
- השרת מתפרסם אוטומטית מ־`.github/workflows/cms-worker.yml` בכל שינוי בתיקייה הזאת בענף הפרסום.

## הגדרה חד־פעמית (בעל האתר)

### 1. מזהה מ־Google
1. <https://console.cloud.google.com> → פרויקט חדש `heichal-cms`.
2. APIs & Services → OAuth consent screen → Get started: שם `היכל הקודש עריכה`, המייל שלכם, External, Create.
3. Audience → Publish app.
4. Clients → Create client → Web application. ב־Authorized JavaScript origins: `https://148-gif.github.io` → Create.
5. מעתיקים את ה־Client ID ושולחים אותו (הוא לא סודי). הוא נכנס ל־`GOOGLE_CLIENT_ID` ב־`wrangler.toml` ול־`googleClientId` ב־`site/admin/config.json`.

### 2. מפתח Cloudflare (כדי ש־GitHub יפרסם את השרת)
1. <https://dash.cloudflare.com/profile/api-tokens> → Create Token → בתבנית **Edit Cloudflare Workers** לוחצים Use template.
2. Account Resources: החשבון שלכם. Zone Resources: All zones. → Continue to summary → Create Token → מעתיקים.

### 3. מפתח GitHub לשרת
<https://github.com/settings/personal-access-tokens/new> → Only select repositories → `Web` →
Permissions: Contents **Read and write**, Actions **Read-only** → Generate token → מעתיקים.

### 4. שמירת שני המפתחות ב־GitHub
<https://github.com/148-gif/Web/settings/secrets/actions> → New repository secret, פעמיים:

| Name | Secret |
|---|---|
| `CLOUDFLARE_API_TOKEN` | המפתח משלב 2 |
| `CMS_GITHUB_TOKEN` | המפתח משלב 3 |

המפתחות האלה לא נשלחים לאף אחד: GitHub מעביר אותם ישירות ל־Cloudflare.

### 5. הפעלה
בפרסום הבא של התיקייה הזאת (או Actions → Deploy editor login server → Run workflow) השרת עולה.
את כתובת השרת (`https://heichal-cms.<…>.workers.dev`, מופיעה ביומן של הריצה) כותבים ב־`worker` ב־`site/admin/config.json`.

## ניהול שוטף

- **להוסיף או להסיר עורך:** בעורך, "ניהול עורכים". הסרה תופסת מיד, גם למי שכבר מחובר.
- **להוסיף בעלים:** מוסיפים ל־`OWNERS` את הגיבוב של המייל (`printf %s "name@gmail.com" | sha256sum`), אחרי פסיק.
- **לנתק את כולם:** מחליפים את `CMS_GITHUB_TOKEN` (ההתחברויות חתומות במפתח שנגזר ממנו).
- **מי שינה מה:** כל שמירה נרשמת במאגר עם "נערך על ידי: <מייל>".
- **מה אפשר לשנות דרך העורך:** רק קבצים בתיקייה `data/` (חוץ מ־`shut.json`), ורק בענף הפרסום.
- **מעבר לדומיין פרטי:** מוסיפים את הכתובת ב־Google (שלב 1.4) ומעדכנים את `ALLOWED_ORIGIN`.

## כתובת באנגלית לפי המשמעות

כשיוצרים נושא או פריט, השרת מציע כתובת באנגלית: קודם מילון קבוע (`GLOSSARY` ב־`worker.mjs`), ואחרת תרגום של Workers AI (`[ai]` ב־`wrangler.toml`).
העלות חסומה: עד 100 תרגומים ביום לעורך ו־300 לכל האתר (משתנים `TRANSLATE_PER_USER` ו־`TRANSLATE_PER_DAY`), ואחרי זה חוזרים לתעתיק לפי ההגייה.
בתוכנית החינמית של Cloudflare, חריגה מהמכסה היומית רק מכשילה את התרגום ולא מחייבת. מומלץ להישאר בלי אמצעי תשלום בחשבון.

## מדיה: תמונות, סרטונים, שמע ומסמכים

ספריית המדיה בעורך (`#/media`) מעלה קבצים בחלקים. השרת בוחר איפה לשמור לפי הסוג והגודל, וסופר את המכסה החינמית של כל מקום:
- **עם האתר (מאגר GitHub):** תמונות, שמע ומסמכים עד 8MB לקובץ וכ־250MB בסך הכול (`MEDIA_GH_FILE_MB`, `MEDIA_GH_TOTAL_MB`).
  הם ממתינים ב־D1 כשינוי ממתין, ומפורסמים לתיקייה `site/media/` באותו קומיט של הפרסום.
- **R2 (`heichal-media`):** סרטונים וקבצים גדולים, עד 90MB לקובץ ו־9GB בסך הכול (`MEDIA_R2_FILE_MB`, `MEDIA_R2_TOTAL_GB`), מתוך 10GB חינם.
  הם חיים מיד, ומוגשים דרך השרת בכתובת `/m/<קובץ>`. כדי להגיש ישירות מהדלי, מפעילים בו גישה ציבורית ושמים את הכתובת ב־`MEDIA_PUBLIC_URL`.
- קובץ שיחרוג מהמכסה לא יתקבל, ויוצגו הסיבה והצעה (כיווץ, או קישור לסרטון ב־YouTube).
- דף שמצביע על קובץ שעוד לא פורסם לא יתפרסם בלעדיו, והעורך מצרף אותו לפרסום אוטומטית.
- כשהאתר יעבור לדומיין משלו: מעדכנים את `MEDIA_PUBLIC_URL`, את ה־CSP של דף העריכה (`img-src`, `media-src`) ואת `ALLOWED_ORIGIN`.
