# osm-trainer

Proof of concept web app for interacting with a smart trainer over Web Bluetooth.

## Local development

Because Web Bluetooth requires HTTPS, serve the app via a local HTTPS server (or deploy
with GitHub Pages). For a quick local preview you can use something like:

```bash
python -m http.server 8080
```

Then visit `http://localhost:8080` (note: Web Bluetooth will not connect without HTTPS).

## App features

- Connect to FTMS trainers and read indoor bike telemetry.
- Map-based grade display with OpenStreetMap tiles.
- Auto resistance loop based on grade.
- Connect to Zwift Play and log button notifications.
