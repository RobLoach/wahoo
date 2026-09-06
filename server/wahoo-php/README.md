# Wahoo PHP relay server

A dedicated Wahoo server that runs on plain PHP shared hosting (no WebSockets,
no long-running processes). Clients poll over HTTPS; game state lives in
SQLite. The server is a *relay*: it owns rooms, seats, turn order, and
versioning, while the game rules run in the clients (the same TypeScript
engine used everywhere else). Fine for friendly games; a modified client could
cheat on its own turn but can never act out of turn or as someone else.

## Deploy (e.g. DreamHost)

1. Point a (sub)domain — e.g. `wahoo.robloach.net` — at this directory with
   HTTPS enabled.
2. `composer install --no-dev`
3. Ensure `./data` is writable by PHP (it's created automatically).
4. Visit the domain in a browser: it should redirect to the game. In the
   game's **Online Game → Use a dedicated server** panel, the default server
   URL is already `https://wahoo.robloach.net`.

Requirements: PHP >= 8.1 with pdo_sqlite, Apache with mod_rewrite (or map all
routes to `index.php` on your web server of choice).

## Local development

```sh
composer install
php -S 127.0.0.1:8099 index.php
```

Then point the game client's dedicated-server URL at `http://127.0.0.1:8099`.

## Endpoints

- `GET /` → redirects to the game
- `POST /api/rooms` → create a room (creator hosts, takes seat 0)
- `POST /api/rooms/{code}/join` → join, reclaim a seat by token, or spectate
- `GET /api/rooms/{code}?clientId=…` → poll the room snapshot
- `POST /api/rooms/{code}/sit|cpu|start|again|state|leave`

Rooms untouched for a week are cleared automatically to make room for new
lobbies; players silent for ~75s are handed to a CPU (reclaimable by rejoining
with the same browser).

## Long polling

Polls with `wait=1` are held for up to ~10 seconds until the room changes, so
moves reach other players almost immediately. Each held poll occupies a PHP
worker; any normal Apache/FPM setup handles this fine, but when testing with
the built-in server use `PHP_CLI_SERVER_WORKERS=6 php -S …` so held polls
don't block other requests.

## Security notes

- `data/` (the SQLite file holds every seat token) is blocked from the web by
  the root `.htaccess` **and** a self-healing `data/.htaccess`. On non-Apache
  hosts, set the `WAHOO_DB` environment variable to an absolute path outside
  the docroot instead.
- Requests larger than ~400 KB are rejected before parsing; posted game states
  are size- and shape-checked (including the log strings other clients render).
- Room creation (20/h), joins (60/h) are throttled per IP; renames and emotes
  have a per-client cooldown.
- Errors return bare JSON — no stack traces.
