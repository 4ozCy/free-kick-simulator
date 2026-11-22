# Publishing on itch.io

Everything here was made for the itch.io project page. The page itself is set up in your itch.io dashboard.

## 1. The game file
- Get `retro-freekick-web.zip` from the latest GitHub Actions run (artifact **retro-freekick-web**), or zip `www/index.html` and `www/game.js` yourself.
- Create a new project. Set **Kind of project** to **HTML** and upload the zip.
- Tick **This file will be played in the browser**.

## 2. Embed options
- **Viewport dimensions:** 360 x 640 (portrait).
- Tick **Mobile friendly** and set the orientation to **Portrait**.
- Tick **Fullscreen button**. On mobile, **Click to launch in fullscreen** works best.
- Leave **Automatically start on page load** off. Sound only starts after a tap anyway.

## 3. Page details
- **Title:** Retro Free Kick
- **Short description / tagline:** Bend it, dip it, knuckle it. A pixel free-kick game with far too much chaos.
- **Genre:** Sports
- **Tags:** soccer, football, pixel-art, retro, sports, arcade, physics, funny, mobile, free-kick
- **Description:** paste the contents of `description.html`.
- **Cover image:** `cover.png` (630 x 500).
- **Screenshots:** the five files in `screenshots/`.

## 4. Theme (Edit theme on the project page)
Matches the in-game palette.
| Setting | Value |
|---|---|
| Background | `#0e1030` |
| Background image | `bg-tile.png`, repeat |
| Banner image | `banner.png` |
| Inner column background | `#161a40` |
| Text | `#e6eee6` |
| Links | `#ffe040` |
| Buttons | `#c82828`, button text `#ffffff` |
| Font | a pixel font if itch.io's list offers one, otherwise the default |

## 5. Optional: Android download
You can also upload `app-debug.apk` (artifact **retro-freekick**) and tag it Android. It installs by sideloading. A release-signed APK would be better for a public download.
