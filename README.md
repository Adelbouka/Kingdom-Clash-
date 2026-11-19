# ⚔️ Kingdom Clash

لعبة ممالك ثلاثية الأبعاد أونلاين في المتصفح: ❄️ مملكة الجليد، 🔥 مملكة النار، 🏜️ مملكة الرمال، وفي الوسط 🌲 غابة النزاع.

A 3D online medieval kingdoms browser game (Three.js + Node.js WebSocket server).

## التشغيل على جهازك
```bash
npm install
ADMIN_KEY=كلمة-سرية npm start
# افتح http://localhost:3000  — لوحة صاحب اللعبة: http://localhost:3000/admin
```

## النشر على Render (مجاني)
1. ادخل render.com وسجّل بحساب GitHub.
2. New → Blueprint → اختر هذا المستودع (يقرأ `render.yaml` تلقائيًا).
3. بعد النشر: Environment → ستجد `ADMIN_KEY` (مفتاح لوحة التحكم).
4. رابط اللعبة: `https://kingdom-clash.onrender.com` — اللوحة: `/admin`

> الخطة المجانية تنام بعد 15 دقيقة بلا زوار، وأول دخول بعدها يأخذ ~50 ثانية.

## حفظ تقدم اللاعبين بشكل دائم (مهم)
بدون قاعدة بيانات، تُحفظ الحسابات في ملف داخل السيرفر ويُمسح عند إعادة النشر أو عندما ينام السيرفر المجاني.
للحفظ الدائم: أنشئ قاعدة MongoDB Atlas مجانية (M0) وضع رابطها في Render ← Environment ← `MONGODB_URI`.

## الملفات
- `server.js` — السيرفر: الملفات + اللاعبين + الدردشة + الإعلانات والأحداث.
- `public/index.html` — اللعبة كاملة.
- `public/admin.html` — لوحة صاحب اللعبة.
- `public/m/` — النماذج والأصوات والترجمات.

## الحقوق
- نماذج الشخصيات والمباني: KayKit (Kay Lousberg) — CC0.
- القلاع والمنجنيقات: Kenney — CC0. الحيوانات: Quaternius — CC0.
- الأصوات: OpenGameArt (CC0) — rubberduck، StarNinjas، Fantozzi، Corsica_S وغيرهم.
- الأيقونات: game-icons.net — CC BY 3.0.
