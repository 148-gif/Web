# כניסה לעורך האתר עם Google

עורך האתר (`/admin/`) מתחבר עם חשבון Google. שרת קטן וחינמי ב־Cloudflare (הקוד ב־`worker.mjs`) בודק שהמייל מורשה,
ורק אז שומר את השינוי במאגר. מפתח ה־GitHub נשמר רק בשרת, והעורכים לא רואים אותו.

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

### 6. דיווח על כישלונות במייל (מומלץ)
כל כישלון באתר נשלח אליכם במייל, עם כל הפרטים: מה נעשה, השגיאה, מי עשה את זה, באיזה עמוד ובאיזה דפדפן, ובכישלון פרסום גם סוף הלוג של GitHub.
המיילים נשלחים דרך Resend (חינם עד 3,000 בחודש), ולא צריך דומיין:
1. נרשמים ב־<https://resend.com> **עם המייל שאליו רוצים לקבל את הדיווחים** → API Keys → Create API Key (Sending access) → מעתיקים.
2. ב־<https://github.com/148-gif/Web/settings/secrets/actions> מוסיפים שני secrets: `RESEND_API_KEY` (המפתח) ו־`REPORT_TO` (אותו מייל, לא כתוב בקוד כי המאגר ציבורי; אפשר כמה מיילים עם פסיק).
3. מפעילים את Deploy editor login server (Actions → Run workflow), והמפתחות עוברים לשרת.

מה מדווח:
- **שמירה וטעינה בעורך:** כל תשובת שגיאה מ־GitHub או מהשרת, וגם נפילת רשת. שגיאת 404 בקריאה והתנתקות רגילה אחרי 12 שעות לא מדווחות.
- **פרסום:** ריצה של Pages או של השרת שנכשלה (הטסטים, הבנייה או הפריסה) נשלחת מ־GitHub Actions עם השלב שנכשל ואחרון הלוג. פרסום שלוקח יותר מ־8 דקות מדווח מהעורך.
- **גולשים:** קובץ של האתר שלא נטען, שגיאת קוד, וחיפוש או זמני יום שנכשלו (`site/report.js`). בלי IP, בלי חיפושים ובלי כלום אחרי סימן השאלה בכתובת. לא נשלח כשאין חיבור.
- **שרת העריכה עצמו:** כל חריגה בלתי צפויה.

כדי שלא יוצף המייל: אותו כישלון נשלח פעם אחת בשעה מעורך (פעם ב־6 שעות מגולש), עם ספירה של החזרות בדיווח הבא, ויש מכסה יומית (20 מגולשים, 100 מעורכים ומהשרת). דיווח מגולש מסומן ״לא מאומת״ כי כל אחד יכול לשלוח אותו.
בלי שני ה־secrets האלה שום דבר לא נשלח והאתר ממשיך לעבוד כרגיל.

## ניהול שוטף

- **להוסיף או להסיר עורך:** בעורך, "ניהול עורכים". הסרה תופסת מיד, גם למי שכבר מחובר.
- **להוסיף בעלים:** מוסיפים ל־`OWNERS` את הגיבוב של המייל (`printf %s "name@gmail.com" | sha256sum`), אחרי פסיק.
- **לנתק את כולם:** מחליפים את `CMS_GITHUB_TOKEN` (ההתחברויות חתומות במפתח שנגזר ממנו).
- **מי שינה מה:** כל שמירה נרשמת במאגר עם "נערך על ידי: <מייל>".
- **מה אפשר לשנות דרך העורך:** רק קבצים בתיקייה `data/` (חוץ מ־`shut.json`), ורק בענף הפרסום.
- **מעבר לדומיין פרטי:** מוסיפים את הכתובת ב־Google (שלב 1.4) ומעדכנים את `ALLOWED_ORIGIN`.
