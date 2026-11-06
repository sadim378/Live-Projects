# GUB Canteen — Animated Student Website + Owner / Admin Dashboard

Functional **Python + SQLite prototype** for Green University students. Students can order canteen-price food and other students can accept a campus delivery job. Owner/staff can manage the menu, pricing, accounts, orders, and activity from a secured dashboard.

## IMPORTANT — First run (Windows / VS Code)

**This ZIP is intentionally packaged without an extra nested project folder.** After extracting, open the folder containing `server.py` in VS Code.

1. Install Python 3.9+ if not already installed.
2. In VS Code Terminal run **once**:
   ```powershell
   python server.py --create-owner
   ```
   When prompted, choose an owner username (e.g. `owner`), your display name and a **new password of at least 12 characters**. Use a password that is **not** your actual Green University password. The password will not display when typed. There is **no preset username/password**.
3. Start the website server:
   ```powershell
   python server.py
   ```
4. Student website: **http://127.0.0.1:8000/**
5. Owner/Admin Dashboard: **http://127.0.0.1:8000/admin.html**

You can also double-click `01-CREATE-OWNER.bat` (once) and then `02-START-SERVER.bat` on Windows.

> `python server.py --create-owner` **does not** start the website server. It only creates the first owner. Run `python server.py` afterwards. If Python is called `py` on your Windows system, use `py server.py` instead.

## Where to find owner features

- **Overview:** all-time orders, active deliveries, registered accounts, recent sign-ins, delivered-order platform/courier allocations, and a seven-day order chart.
- **Menu manager:** add/edit a food, price, tag, category, visibility, and upload a real photo (JPEG/PNG/WebP, max **2 MB**). Admin can archive a product without deleting order history. There is no need to edit HTML or JSON whenever the canteen menu changes.
- **Beverages, Cakes, Biscuits:** 11 sample products preloaded as **hidden drafts**, with **example** prices only. Before selling them, an admin should add accurate canteen prices/photos, confirm stock and toggle **Visible to students**. These initial names and amounts are not represented as confirmed GUB canteen offerings.
- **All orders:** view order lines, buyer details, rider, destination, live order status; assign/reassign a student courier, unassign, cancel with reason, reopen cancelled orders or mark a delivery complete with recorded reason. These actions have audit logs.
- **Students & staff:** registered users, phone/student ID, account creation and last login, order/delivery count, active/disabled status; suspend/enable accounts. **Only the owner** can promote a registered student to admin or demote staff. Changes to roles sign the affected user out.
- **Activity logs:** registration, staff/student sign-ins, logouts, order placements and delivery stages, menu changes, account access/roles, uploaded images and settings changes.
- **Account security:** owner and administrators can change their own password from **Delivery pricing → Account security** using their current password; other sessions are revoked. If the owner forgets their password, the person with local server-file access can recover it with `python server.py --reset-owner-password`.
- **Delivery pricing:** owner can edit the minimum fee, increase per tier, items per tier, and platform commission percentage. Existing orders retain the prices and split quoted when placed.
- **CSV exports:** order, account and activity database export, accessible only to signed-in staff.

## Delivery calculation

By default, quantity-based delivery fee is **৳15 for 1–2 items**, increasing by **৳5 for every additional two items**. The platform commission remains the same percentage of the **delivery fee**, *not* the food subtotal:

**Platform share = round(delivery fee × 33⅓%)**; **courier share = delivery fee − platform share**.

| Items | Delivery charge | Platform approx. 33⅓% | Student courier |
| :--- | ---: | ---: | ---: |
| 1–2 | ৳15 | ৳5 | ৳10 |
| 3–4 | ৳20 | ৳7 | ৳13 |
| 5–6 | ৳25 | ৳8 | ৳17 |
| 7–8 | ৳30 | ৳10 | ৳20 |
| 9–10 | ৳35 | ৳12 | ৳23 |

Commission allocation is rounded to the nearest whole taka. The original 15/5/10 model is preserved at the starting tier. Only the **fee** is split; the canteen's food total is not marked up.

## Testing from two student accounts

1. Open the site in one browser, create a student account and order food from the menu.
2. Open a separate private/incognito window or a second browser and register a different student account.
3. Go to **Deliver & Earn**, accept the open job and mark **Picked up**, then **Delivered**.
4. Refresh the first account's order drawer and the owner dashboard to see live status and accounting values.
5. Order delivery details and logins are stored in the SQLite database file `canteen.db` in the project folder.

The student site also has a local **browser-only demo mode** if opened with Live Server. This demo does not use the SQLite database or support a real admin dashboard. For testing owner features and cross-account orders, **you must use `python server.py`**.

## Keep your existing orders and users

If you used the previous full-stack ZIP and already have real/demo users or orders in `canteen.db`:

1. Stop the old server (`Ctrl+C`).
2. **Back up** its `canteen.db` (and any `-wal` / `-shm` files *if present after stopping*).
3. Copy the old `canteen.db` into this new project folder **before running either setup command**.
4. Run `python server.py --create-owner`. The server automatically adds new tables and account fields to the old SQLite schema while keeping old orders and students.
5. Start with `python server.py`.

If you do not have a previous `canteen.db`, just follow the fresh-install steps.

**Do not overwrite your existing data with a ZIP from someone else.** This ZIP intentionally contains no user database, uploaded user photos, passwords, or test accounts.

## Files

- `server.py` — Python standard-library HTTP server, authenticated API, SQLite setup/migration.
- `admin.html`, `admin.css`, `admin.js` — owner/staff console.
- `index.html`, `style.css`, `main.js` — responsive animated student website.
- `menu.json` — original 20 item reference; database becomes the active editable menu when Python server is running.
- `images/` — images from the original project.
- `uploads/` — created automatically for photos added by admins.
- `canteen.db` — auto-created on first run; stores accounts, sessions, menu, orders, settings and activity.

## Important limitations before a real university-wide launch

This is a **working prototype, not a production-ready online commerce system**. Passwords are hashed, sessions use HttpOnly/SameSite cookies, authenticated updates check CSRF tokens, staff/owner roles are separated, admin uploads are restricted and database files are not exposed by static routes. Still, launching to actual students requires HTTPS/hosting, university ID verification, canteen confirmation of all prices and inventory, stronger login abuse protection, backup/restore procedures, explicit user privacy rules, courier disputes and payment reconciliation. A real payment gateway, canteen POS, cash collection confirmation, push notifications, rider location and automated student verification are **not integrated**. Earnings/revenue represent calculated order fees, not settled or collected money.

This project is independently built for student demonstration and is **not an official Green University of Bangladesh service**.
