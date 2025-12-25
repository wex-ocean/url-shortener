# Modern URL Shortener (Frontend-only)

A fast, modern, SaaS-style URL shortener UI built with:
- HTML
- CSS
- Tailwind CSS (CDN)
- JavaScript
- jQuery

No backend required. Everything is simulated using `localStorage`.

## Features

### Core
- Shorten a long URL (frontend logic)
- Optional custom alias/slug
- URL validation (auto-prepends `https://` if no scheme)
- Prevent duplicate slugs via `localStorage`
- API-ready data model structure

### Copy to Clipboard
- One-click Copy (Clipboard API with fallback)
- Feedback via toast + button icon/text update
- Copy disabled until link exists

### Advanced (Frontend-focused)
- Click tracking simulation (increments when you click the short URL in the UI)
- Link management:
  - Enable / Disable links
  - Optional expiration date (auto-disables when expired)
  - Edit destination URL
  - Edit slug with uniqueness check
  - Delete links
- Analytics modal:
  - Click count
  - Creation date
  - Expiry date
  - Status indicator

### UX Enhancements
- Light / Dark mode toggle (persisted)
- Toast notifications
- Loading state on shorten action
- Empty state in dashboard
- Keyboard accessibility:
  - ESC closes modals
  - Focus moves to modal content on open

## Project Structure

/url-shortener
 ├── index.html
 ├── css/
 │   └── style.css
 ├── js/
 │   └── main.js
 ├── assets/
 └── README.md

## Run

Just open `index.html` in your browser.

> Note: Clipboard API works best on HTTPS or localhost. A fallback is included.

## localStorage Keys

- `shortly_users_v1`
- `shortly_session_v1`
- `shortly_links_v1`
- `shortly_theme_v1`

## How click tracking works

Clicking the displayed short URL inside the app:
- checks status (active/disabled/expired)
- increments click count in `localStorage`
- opens the destination in a new tab

This simulates “short URL access” without a backend.