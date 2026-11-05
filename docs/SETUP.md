# Putting Gharowa online

## 1. Host the website on Cloudflare Pages (free)

1. Push this repository to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick `gharowa`.
3. Build settings: **Framework preset** None, **Build command** leave empty, **Build output directory** `web`.
4. Deploy. The site goes live at `https://gharowa.pages.dev` (if Cloudflare gives a different name, see step 3 below).

Every push to `main` redeploys automatically.

## 2. Use your own domain (optional)

Cloudflare Pages project → **Custom domains** → add e.g. `gharowa.in`. Then add `https://gharowa.in/**` in Supabase redirect URLs (next step) and change the Site URL to it.

## 3. Supabase sign-in settings

Already set: Site URL `https://gharowa.pages.dev`, redirect URLs `https://gharowa.pages.dev/**` and `https://*.gharowa.pages.dev/**`.
If your site address is different, update both in Supabase → Authentication → URL Configuration.

## 4. Make yourself admin

`brmcomid@gmail.com` is already listed as admin. Sign in on the site with that email and open `/admin.html`.
To add another admin, run in the SQL Editor:

```sql
insert into public.app_admins (email) values ('someone@example.com');
```

## 5. Before real customers

- **Email sending:** Supabase's built-in email only sends a few emails an hour. Connect a free sender like Resend under Authentication → Emails → SMTP Settings. Then you can also edit the Magic Link template to include `{{ .Token }}`, so the email shows a 6-digit code as well as the link.
- **Phone sign-in:** needs an SMS provider (Twilio, MSG91) under Authentication → Sign In / Providers → Phone.
- **Online payments:** orders are pay-on-delivery for now. Razorpay is the next step (needs a Razorpay account and an Edge Function).
- **Delivery partners:** if no Gharowa rider is free, the order waits as "searching" and shows on the admin page, where you can assign a rider. Pidge or Shiprocket Quick can be plugged in later through an Edge Function.
- **Rider payouts:** riders request payouts in the app; you send the money by UPI and mark it paid with the reference on the admin page. RazorpayX can automate this later.
- **FSSAI:** collect each cook's FSSAI registration before approving them.

## 6. Test the backend

Paste `supabase/tests/website_flow_test.sql` into the SQL Editor and run it. It plays a full order as a cook, rider, customer and admin, then rolls everything back. The result appears as an error starting with `TEST_DONE` listing each check.
