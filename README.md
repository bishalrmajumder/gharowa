# Gharowa · ঘরোয়া

Home-cooked Bengali food from Bengali home kitchens, for Bengalis living in Bangalore, Chennai, Gurgaon and Hyderabad.

One website with four sides, all on one Supabase database:

| Page | Who | What it does |
|---|---|---|
| `index.html` | Customers | Browse kitchens in your city, order now or pre-order a slot, saved addresses with map pin, live tracking with rider on the map, delivery code, ratings |
| `cook.html` | Home cooks | Kitchen sign-up with pickup pin, approval status, open / 15-minute toggles, menu with plates left, pre-order vs now, delete, live orders, pickup-code handover |
| `rider.html` | Riders | Sign-up, online toggle with live location, auto-assigned pickups, map + directions, pickup and drop codes, earnings wallet, settle to UPI anytime |
| `admin.html` | You | Approve kitchens and riders, assign a rider when none was free, settle payout requests, today's numbers |

## Folder structure

```
gharowa/
├── web/                     The website (plain HTML/CSS/JS, no build step)
│   ├── index.html           Customer app
│   ├── cook.html            Cook app
│   ├── rider.html           Rider app
│   ├── admin.html           Admin
│   ├── assets/css/app.css
│   ├── assets/js/
│   │   ├── config.js        Supabase URL + public anon key, fees
│   │   ├── core.js          Shared: Supabase client, sign-in, maps, helpers
│   │   ├── customer.js / cook.js / rider.js / admin.js
│   ├── assets/img/icon.svg
│   ├── manifest.webmanifest Add-to-home-screen support
│   └── _headers             Security headers for Cloudflare Pages
├── supabase/
│   ├── migrations/          Database, in the order it was applied (001 → 004)
│   └── tests/               Full order-flow test you can run in the SQL Editor
└── docs/
    ├── prototype.html       The clickable prototype
    └── SETUP.md             Hosting, admin, email and launch checklist
```

## Backend

Supabase project `iihnssqevheqhvcqppun` (Mumbai). All four migrations are already applied.

- **Security:** Row Level Security on every table. Totals, stock, order status, codes, approvals and wallets can only change through server functions (`place_order`, `cook_set_status`, `cook_handover`, `rider_deliver`, `request_payout`, `admin_*`), so the browser can't fake them.
- **Automations:** profile on sign-up, plates reserved per order (no overselling), nearest free rider auto-assigned when food is packed, wallet credited on delivery, cook rating updated on review.
- **Privacy:** customers never see a cook's home address; cooks see only the customer's first name and area; pickup and drop codes are only shown to the right person.

## Run it locally

Any static server works, for example from the `web` folder:

```
npx serve .
```

Then open the address it prints. To sign in locally, add that address (e.g. `http://localhost:3000/**`) under Supabase → Authentication → URL Configuration → Redirect URLs.

See [docs/SETUP.md](docs/SETUP.md) to put it online.
