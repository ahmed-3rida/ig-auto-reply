# رد تلقائي على تعليقات انستجرام

لكل فيديو رابط مختلف. لما حد يكتب **أي كومنت** على فيديو مفعّل:
1. يتبعتله **رسالة خاصة (DM)** فيها رابط الفيديو ده.
2. يترد على تعليقه برد قصير زي «بعتلك الرابط في الخاص ❤️».

بتتحكم في كل ده من **لوحة الإعدادات** على رابط موقعك. تعليقاتك إنت بيتم تجاهلها.

---

## 1) حوّل حساب انستا لـ Professional
Settings and activity ← Account type and tools ← Switch to professional account ← **Creator**.

## 2) اعمل تطبيق Meta
1. ادخل https://developers.facebook.com/apps ← **Create App**.
2. اختار use case: **Manage messaging & content on Instagram**.
3. من **Instagram ← API setup with Instagram login**:
   - دوس **Add account** واعمل login بحساب انستا بتاعك.
   - دوس **Generate token** وانسخ الـ token (ده `IG_ACCESS_TOKEN`).
4. من **App settings ← Basic** انسخ **Instagram app secret** (ده `APP_SECRET`).

## 3) ارفع السيرفر على Vercel
1. ارفع الفولدر ده على GitHub، واعمل Import له على https://vercel.com/new.
2. في **Environment Variables** حط القيم دي:

| الاسم | القيمة |
|---|---|
| `IG_ACCESS_TOKEN` | الـ token من خطوة 2 |
| `APP_SECRET` | الـ app secret من خطوة 2 |
| `VERIFY_TOKEN` | أي كلمة سر تختارها، مثلاً `my-secret-123` |
| `COMMENT_REPLY` | (اختياري) الرد على التعليق |
| `DM_MESSAGE` | (اختياري) نص الرسالة الخاصة، وتقدر تكتب فيه `{username}` و `{link}` |
| `IG_USERNAME` | يوزر حسابك (عشان النظام ميردش على نفسه) |
| `ENABLED` | `true` للتشغيل، و `false` للإيقاف |
| `IG_USER_ID` | ID حسابك على انستا (اختياري) |

3. اعمل Deploy، وهيطلعلك رابط زي `https://ig-auto-reply.vercel.app`.

## 4) اربط الـ Webhook
في تطبيق Meta ← **Instagram ← API setup with Instagram login ← Configure webhooks**:
- **Callback URL:** `https://<رابطك>.vercel.app/api/webhook`
- **Verify token:** نفس قيمة `VERIFY_TOKEN`
- دوس **Verify and save**، وبعدين فعّل (Subscribe) حقل **comments**.
- وتحت عند الحساب، فعّل **Webhook subscription**.

## 5) لوحة الإعدادات (رابط لكل فيديو)
افتح رابط موقعك نفسه (مثلاً `https://ig-auto-reply-theta.vercel.app`) واكتب كلمة السر (نفس `VERIFY_TOKEN`).
- هتلاقي كل بوستاتك والريلز بالصور.
- لكل فيديو: فعّل «رد تلقائي» وحط **الرابط بتاعه** ← **حفظ الإعدادات**.
- أي كومنت على الفيديو المفعّل هياخد رد + رسالة خاصة فيها رابط الفيديو ده بالذات.
- اختياري: كلمة معينة (لو عايز الرد يبقى على كومنتات فيها الكلمة دي بس)، أو رسالة/رد مخصوص للفيديو.
- الزرار اللي فوق يوقف النظام كله.

**التخزين:** الإعدادات بتتحفظ على Vercel Blob. من Vercel ← Storage ← Create ← Blob، واربطه بالمشروع (هيضيف `BLOB_READ_WRITE_TOKEN` لوحده)، وبعدين Redeploy.

## 6) جرّب
فعّل فيديو من اللوحة، وخلي **حساب تاني** يعلّق عليه. المفروض الرسالة الخاصة والرد يوصلوا في ثواني.
لو موصلش حاجة، افتح Vercel ← Logs وشوف فيه `Graph error` ولا لأ.

> لو الـ Webhook مش بيوصل والتطبيق في وضع Development، غيّر التطبيق لـ **Live**. ممكن Meta تطلب Privacy Policy URL، وساعتها أي صفحة بسيطة هتنفع.

## اختبار محلي
```bash
node test.mjs
```
(محتاج `npm install` الأول.)
