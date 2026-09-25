# Changelog

## [1.0.0] — 2026-09-25

### Added
- Google Apps Script backend: single RPC router (`api`) with session validation, RBAC (EMPLOYEE / KITCHEN / ADMIN / VIEWER) and standard response format + error codes
- Employee ID + PIN authentication (salted, peppered, iterated SHA-256), rate limiting, account lockout, forced PIN change, sessions with sliding expiry / remember-me / revoke
- Google Sheets database with 15 sheets, idempotent `setupDatabase()`, batch read/write data layer with TextFinder lookups and caching
- Meal windows (BREAKFAST / LUNCH / DINNER) with auto-create, auto open/close, manual override, hard cutoff
- Menu Master + Daily Menu (per-window price / stock / max per order), image upload to Drive
- Ordering: multi-item cart, notes, idempotent create (`request_token`), edit / cancel before cutoff, LockService-protected stock, price verification, order number `ORD-YYMMDD-XXXX`, snapshots of name/price
- Kitchen: dashboard (KPIs, per-menu bar chart, department donut, stock), order list (filters, search, pagination, bulk status), pickup with QR / scanner / camera and double-pickup protection, printable final summary
- Admin: dashboard with health checks, employee management (CSV import, reset PIN, enable/disable), meal window management, order management, reports (daily / weekly / monthly / menu / department / employee / cancellation / no-show / revenue) with CSV export, LINE settings + queue + manual retry, audit / error / system logs, settings, triggers, backup, sample-data cleanup
- LINE Messaging API integration with notification queue (INSTANT / SUMMARY / CUTOFF), retry ×3, final summary, system alerts, webhook group-ID capture
- Drive backup `FoodFactory-Backup/YYYY/MM/`, retention, yearly archive
- Mobile-first employee UI and desktop/tablet kitchen & admin UI with shared design system, toasts, confirm dialogs, loading states, empty states, accessibility (labels, focus, aria)
- Node-based Apps Script emulator, backend test suite, local dev server and Playwright E2E test
- Documentation: README, DEPLOYMENT, DATABASE_SCHEMA, LINE_SETUP, TEST_CHECKLIST, DELIVERY_REPORT
