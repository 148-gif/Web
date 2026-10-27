# כניסה לעורך האתר עם Google: הגדרה חד־פעמית

עורך האתר (`/admin/`) מתחבר עם חשבון Google. שרת קטן וחינמי ב־Cloudflare (הקוד ב־`worker.mjs`) בודק שהמייל נמצא ברשימת המורשים,
ורק אז שומר את השינוי במאגר. מפתח הגישה ל־GitHub נשמר רק בשרת הזה, והעורכים לא רואים אותו.

ההגדרה לוקחת בערך 20 דקות, ועושים אותה פעם אחת. יש ארבעה שלבים.

## 1. מפתח GitHub לשרת

1. נכנסים ל־<https://github.com/settings/personal-access-tokens/new>.
2. נותנים שם (למשל "עורך האתר") ותוקף (עד שנה; כשיפוג, יוצרים חדש ומחליפים בשלב 3).
3. ב־Repository access בוחרים Only select repositories, ואת `148-gif/Web`.
4. ב־Repository permissions: ‏**Contents: Read and write**, ו־**Actions: Read-only**.
5. Generate token, ומעתיקים את המפתח (הוא מוצג פעם אחת בלבד).

## 2. מזהה התחברות של Google

1. נכנסים ל־<https://console.cloud.google.com/>, ויוצרים פרויקט חדש (למשל "heichal-cms").
2. APIs & Services → OAuth consent screen: סוג **External**, שם האפליקציה "היכל הקודש – עריכה", והמייל שלכם. שומרים.
   ב־Audience לוחצים **Publish app** (או מוסיפים את המיילים של העורכים כ־Test users).
3. APIs & Services → Credentials → Create credentials → **OAuth client ID**, סוג **Web application**.
4. ב־Authorized JavaScript origins מוסיפים: `https://148-gif.github.io` (וכשיהיה דומיין פרטי, גם אותו).
5. Create, ומעתיקים את ה־**Client ID** (נגמר ב־`.apps.googleusercontent.com`).

## 3. השרת ב־Cloudflare

1. פותחים חשבון חינמי ב־<https://dash.cloudflare.com/sign-up>.
2. Workers & Pages → Create → Create Worker. נותנים שם `heichal-cms` ולוחצים Deploy.
3. Edit code: מוחקים את הקוד שיש שם, מדביקים את כל התוכן של `cms-worker/worker.mjs` מהמאגר, ולוחצים Deploy.
4. Settings → Variables and Secrets, ומוסיפים:

   | שם | סוג | ערך |
   |---|---|---|
   | `GOOGLE_CLIENT_ID` | Text | ה־Client ID משלב 2 |
   | `ALLOWED_EMAILS` | Text | המיילים של מי שמורשה לערוך, מופרדים בפסיק: `148148v@gmail.com` |
   | `ALLOWED_ORIGIN` | Text | `https://148-gif.github.io` |
   | `REPO` | Text | `148-gif/Web` |
   | `BRANCH` | Text | `claude/greeting-2i183o` |
   | `GITHUB_TOKEN` | **Secret** | המפתח משלב 1 |
   | `SESSION_SECRET` | **Secret** | טקסט אקראי ארוך (לפחות 32 תווים) |

5. מעתיקים את כתובת השרת, למשל `https://heichal-cms.<השם-שלכם>.workers.dev`.

(מי שמעדיף שורת פקודה: `cd cms-worker && npx wrangler deploy`, ואת שני הסודות עם `npx wrangler secret put`.)

## 4. חיבור העורך

בקובץ `site/admin/config.json` ממלאים:

```json
{
  "repo": "148-gif/Web",
  "branch": "claude/greeting-2i183o",
  "worker": "https://heichal-cms.<השם-שלכם>.workers.dev",
  "googleClientId": "….apps.googleusercontent.com"
}
```

אחרי הפרסום, נכנסים ל־`https://148-gif.github.io/Web/admin/` ומתחברים עם Google.
כל עוד `worker` ריק, העורך מבקש מפתח GitHub אישי כמו קודם.

## ניהול שוטף

- **להוסיף או להסיר עורך:** משנים את `ALLOWED_EMAILS` ב־Cloudflare. הסרה תופסת מיד, גם למי שכבר מחובר.
- **לנתק את כולם:** משנים את `SESSION_SECRET`.
- **מי שינה מה:** כל שמירה נרשמת במאגר עם השורה "נערך על ידי: <מייל>" (GitHub → Commits).
- **מה העורך יכול לשנות:** רק קבצים בתיקייה `data/` (חוץ מ־`shut.json`), ורק בענף שבהגדרות. את הקוד, את העיצוב ואת ה־workflows הוא לא יכול לשנות.
- **מעבר לדומיין פרטי:** מוסיפים את הכתובת החדשה ב־Google (שלב 2.4), ומעדכנים את `ALLOWED_ORIGIN`.
