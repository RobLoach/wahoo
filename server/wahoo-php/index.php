<?php

/**
 * Wahoo relay server for PHP shared hosting.
 *
 * This is NOT a rules engine: clients run the shared TypeScript engine and
 * post resulting game states here. The server owns membership (seats, tokens,
 * host), enforces turn order and versioning, and stores state in SQLite so
 * rooms survive as long as anyone is playing. Clients poll for changes.
 *
 * Trust model: fine for friends — a modified client could post an illegal
 * state for its own turn, but never act out of turn or as another player.
 *
 * Deploy: point the domain's docroot at this directory (see .htaccess),
 * run `composer install`, and make sure ./data is writable by PHP.
 */

declare(strict_types=1);

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Factory\AppFactory;

require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/words.php';

const GAME_URL = 'https://robloach.github.io/wahoo';
const ROOM_IDLE_SECONDS = 604800;  // prune rooms untouched for a week
const CLIENT_STALE_SECONDS = 75;   // a client silent this long is treated as gone
const MAX_STATE_BYTES = 300000;
const MAX_ROOMS_PER_IP_PER_HOUR = 20;
const MAX_JOINS_PER_IP_PER_HOUR = 60;
const ACTION_COOLDOWN_SECONDS = 1; // min gap between renames/emotes per client
const MAX_BODY_BYTES = 400000;
const EMOTES = ['wahoo', 'lol', 'gasp', 'smug', 'finger'];

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $file = getenv('WAHOO_DB');
        if ($file === false || $file === '') {
            $dir = __DIR__ . '/data';
            if (!is_dir($dir)) {
                mkdir($dir, 0775, true);
            }
            // Self-heal the Apache deny rule so the database (which holds
            // every seat token) can never be downloaded over HTTP.
            $ht = $dir . '/.htaccess';
            if (!is_file($ht)) {
                file_put_contents($ht, "Require all denied\n");
            }
            $file = $dir . '/wahoo.sqlite';
        }
        $pdo = new PDO('sqlite:' . $file);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec('PRAGMA journal_mode = WAL');
        $pdo->exec('PRAGMA busy_timeout = 5000');
        $pdo->exec('CREATE TABLE IF NOT EXISTS rooms (
            code TEXT PRIMARY KEY,
            seats TEXT NOT NULL,
            game TEXT,
            version INTEGER NOT NULL DEFAULT 0,
            host_client TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS clients (
            id TEXT PRIMARY KEY,
            room_code TEXT NOT NULL,
            name TEXT NOT NULL,
            token TEXT,
            last_seen INTEGER NOT NULL
        )');
        $pdo->exec('CREATE TABLE IF NOT EXISTS rate_limits (
            ip TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )');
        // Migrations for databases created before emotes existed.
        try {
            $pdo->exec('ALTER TABLE rooms ADD COLUMN emote TEXT');
            $pdo->exec('ALTER TABLE rooms ADD COLUMN emote_n INTEGER NOT NULL DEFAULT 0');
        } catch (PDOException) {
            // columns already exist
        }
        try {
            $pdo->exec("ALTER TABLE rate_limits ADD COLUMN kind TEXT NOT NULL DEFAULT 'create'");
            $pdo->exec('ALTER TABLE clients ADD COLUMN last_action INTEGER NOT NULL DEFAULT 0');
        } catch (PDOException) {
            // columns already exist
        }
        try {
            $pdo->exec('ALTER TABLE rooms ADD COLUMN rules TEXT');
        } catch (PDOException) {
            // column already exists
        }
    }
    return $pdo;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(Response $response, array $data, int $status = 200): Response
{
    $response->getBody()->write(json_encode($data));
    return $response
        ->withHeader('Content-Type', 'application/json')
        ->withStatus($status);
}

function errorResponse(Response $response, string $message, int $status): Response
{
    return jsonResponse($response, ['error' => $message], $status);
}

function sanitizeName(mixed $name): string
{
    $clean = preg_replace('/[<>&"\']/', '', (string) ($name ?? ''));
    $clean = mb_substr(trim($clean), 0, 12);
    return $clean === '' ? 'Player' : $clean;
}

function newRoomCode(PDO $pdo): string
{
    for ($i = 0; $i < 60; $i++) {
        $code = ROOM_WORDS[random_int(0, count(ROOM_WORDS) - 1)];
        $exists = $pdo->prepare('SELECT 1 FROM rooms WHERE code = ?');
        $exists->execute([$code]);
        if ($exists->fetchColumn() === false) {
            return $code;
        }
    }
    do {
        $code = '';
        for ($j = 0; $j < 4; $j++) {
            $code .= chr(random_int(65, 90));
        }
        $exists = $pdo->prepare('SELECT 1 FROM rooms WHERE code = ?');
        $exists->execute([$code]);
    } while ($exists->fetchColumn() !== false);
    return $code;
}

function loadRoom(PDO $pdo, string $code): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM rooms WHERE code = ?');
    $stmt->execute([strtoupper($code)]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row === false) {
        return null;
    }
    $row['seats'] = json_decode($row['seats'], true);
    $row['game'] = $row['game'] === null ? null : json_decode($row['game'], true);
    return $row;
}

function saveRoom(PDO $pdo, array $room, bool $bumpVersion = true): void
{
    $stmt = $pdo->prepare(
        'UPDATE rooms SET seats = ?, game = ?, version = ?, host_client = ?, rules = ?, updated_at = ?
         WHERE code = ?'
    );
    $stmt->execute([
        json_encode($room['seats']),
        $room['game'] === null ? null : json_encode($room['game']),
        $room['version'] + ($bumpVersion ? 1 : 0),
        $room['host_client'],
        $room['rules'] ?? null,
        time(),
        $room['code'],
    ]);
}

function touchClient(PDO $pdo, string $clientId): void
{
    $stmt = $pdo->prepare('UPDATE clients SET last_seen = ? WHERE id = ?');
    $stmt->execute([time(), $clientId]);
}

function clientRow(PDO $pdo, string $clientId, string $code): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM clients WHERE id = ? AND room_code = ?');
    $stmt->execute([$clientId, strtoupper($code)]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row === false ? null : $row;
}

function seatOf(array $room, string $clientId): ?int
{
    foreach ($room['seats'] as $i => $seat) {
        if ($seat !== null && ($seat['clientId'] ?? null) === $clientId) {
            return $i;
        }
    }
    return null;
}

/** A CPU seat entry. */
function cpuSeat(string $name, string $difficulty = 'medium', ?string $token = null): array
{
    return ['name' => $name, 'cpu' => true, 'difficulty' => $difficulty, 'clientId' => null, 'token' => $token];
}

const SEAT_COLOR_NAMES = ['Red', 'Blue', 'Green', 'Yellow'];

/** Keep only known house-rule keys with valid values. */
function sanitizeRules(mixed $raw): array
{
    $rules = ['friendlyFire' => true, 'sevenMaxBunnies' => 2, 'burrowJump' => false, 'finger' => true];
    if (is_array($raw)) {
        if (is_bool($raw['friendlyFire'] ?? null)) {
            $rules['friendlyFire'] = $raw['friendlyFire'];
        }
        if (in_array($raw['sevenMaxBunnies'] ?? null, [1, 2, 4], true)) {
            $rules['sevenMaxBunnies'] = $raw['sevenMaxBunnies'];
        }
        if (is_bool($raw['burrowJump'] ?? null)) {
            $rules['burrowJump'] = $raw['burrowJump'];
        }
        if (is_bool($raw['finger'] ?? null)) {
            $rules['finger'] = $raw['finger'];
        }
    }
    return $rules;
}

/** The seat credential: sent as a header (kept out of access logs), with
 *  query/body fallbacks for older clients. */
function clientIdOf(Request $request): string
{
    $header = trim($request->getHeaderLine('X-Wahoo-Client'));
    if ($header !== '') {
        return substr($header, 0, 64);
    }
    $body = (array) $request->getParsedBody();
    $query = $request->getQueryParams();
    return substr((string) ($body['clientId'] ?? $query['clientId'] ?? ''), 0, 64);
}

/** Per-IP sliding-hour throttle shared by room creation and joins. */
function ipThrottled(PDO $pdo, Request $request, string $kind, int $max): bool
{
    $ip = (string) ($request->getServerParams()['REMOTE_ADDR'] ?? 'unknown');
    $pdo->prepare('DELETE FROM rate_limits WHERE created_at < ?')->execute([time() - 3600]);
    $count = $pdo->prepare('SELECT COUNT(*) FROM rate_limits WHERE ip = ? AND kind = ?');
    $count->execute([$ip, $kind]);
    if ((int) $count->fetchColumn() >= $max) {
        return true;
    }
    $pdo->prepare('INSERT INTO rate_limits (ip, created_at, kind) VALUES (?, ?, ?)')
        ->execute([$ip, time(), $kind]);
    return false;
}

/** Min gap between chatty per-client actions (renames, emotes). */
function actionThrottled(PDO $pdo, string $clientId): bool
{
    $stmt = $pdo->prepare('SELECT last_action FROM clients WHERE id = ?');
    $stmt->execute([$clientId]);
    $last = $stmt->fetchColumn();
    if ($last !== false && time() - (int) $last < ACTION_COOLDOWN_SECONDS) {
        return true;
    }
    $pdo->prepare('UPDATE clients SET last_action = ? WHERE id = ?')->execute([time(), $clientId]);
    return false;
}

/** Shallow sanity check that a posted blob looks like a Wahoo GameState. */
function looksLikeGameState(mixed $state): bool
{
    if (!is_array($state)) {
        return false;
    }
    if (!isset($state['bunnies'], $state['players'], $state['drawPile'], $state['discard'])) {
        return false;
    }
    if (!is_array($state['bunnies']) || count($state['bunnies']) !== 16) {
        return false;
    }
    if (!is_array($state['players']) || count($state['players']) !== 4) {
        return false;
    }
    $current = $state['current'] ?? null;
    if (!is_int($current) || $current < 0 || $current > 3) {
        return false;
    }
    // Note: `??` would treat a legitimate null winner as absent.
    if (!array_key_exists('winner', $state)) {
        return false;
    }
    $winner = $state['winner'];
    if ($winner !== null && $winner !== 0 && $winner !== 1) {
        return false;
    }
    // The log and lastPlay strings are rendered by every other client in the
    // room: type-check and bound them so a hostile client can't smuggle in
    // oversized or non-string payloads.
    $log = $state['log'] ?? null;
    if (!is_array($log) || count($log) > 2000) {
        return false;
    }
    foreach ($log as $line) {
        // Structured events (small objects) from current clients, or plain
        // strings from older ones — either way, tightly bounded.
        if (is_string($line)) {
            if (strlen($line) > 400) {
                return false;
            }
        } elseif (is_array($line)) {
            if (strlen(json_encode($line)) > 200) {
                return false;
            }
        } else {
            return false;
        }
    }
    if (($state['lastPlay'] ?? null) !== null) {
        $lp = $state['lastPlay'];
        if (!is_array($lp)) {
            return false;
        }
        if (isset($lp['desc']) && (!is_string($lp['desc']) || strlen($lp['desc']) > 300)) {
            return false;
        }
        if (($lp['card'] ?? null) !== null) {
            $card = $lp['card'];
            if (!is_array($card)
                || !is_string($card['rank'] ?? null) || strlen($card['rank']) > 3
                || !is_string($card['suit'] ?? null) || strlen($card['suit']) > 8) {
                return false;
            }
        }
    }
    return strlen(json_encode($state)) <= MAX_STATE_BYTES;
}

/** Clear rooms nobody has touched for a week, making space for new lobbies. */
function pruneIdleRooms(PDO $pdo): void
{
    $cutoff = time() - ROOM_IDLE_SECONDS;
    $pdo->prepare('DELETE FROM clients WHERE room_code IN (SELECT code FROM rooms WHERE updated_at < ?)')
        ->execute([$cutoff]);
    $pdo->prepare('DELETE FROM rooms WHERE updated_at < ?')->execute([$cutoff]);
}

/** Anyone silent too long is folded into a CPU so the game keeps moving. */
function reapStaleClients(PDO $pdo, array &$room): bool
{
    $changed = false;
    foreach ($room['seats'] as $i => $seat) {
        if ($seat === null || !empty($seat['cpu']) || empty($seat['clientId'])) {
            continue;
        }
        $stmt = $pdo->prepare('SELECT last_seen FROM clients WHERE id = ?');
        $stmt->execute([$seat['clientId']]);
        $lastSeen = $stmt->fetchColumn();
        if ($lastSeen !== false && time() - (int) $lastSeen <= CLIENT_STALE_SECONDS) {
            continue;
        }
        if ($room['game'] !== null && $room['game']['winner'] === null) {
            $room['seats'][$i] = cpuSeat($seat['name'], 'medium', $seat['token'] ?? null);
        } else {
            $room['seats'][$i] = null;
        }
        if ($room['host_client'] === $seat['clientId']) {
            $room['host_client'] = null;
        }
        $changed = true;
    }
    if ($room['host_client'] === null) {
        // Pass host to the most recently seen connected player.
        $stmt = $pdo->prepare(
            'SELECT id FROM clients WHERE room_code = ? AND last_seen >= ? ORDER BY last_seen DESC LIMIT 1'
        );
        $stmt->execute([$room['code'], time() - CLIENT_STALE_SECONDS]);
        $next = $stmt->fetchColumn();
        if ($next !== false) {
            $room['host_client'] = $next;
            $changed = true;
        }
    }
    return $changed;
}

/** The response shape clients poll for; seat tokens/ids stay server-side. */
function snapshot(array $room, string $clientId): array
{
    $seats = [];
    foreach ($room['seats'] as $seat) {
        $seats[] = $seat === null ? null : [
            'name' => $seat['name'],
            'cpu' => (bool) ($seat['cpu'] ?? false),
            'difficulty' => $seat['difficulty'] ?? null,
        ];
    }
    return [
        'code' => $room['code'],
        'version' => (int) $room['version'],
        'ageMs' => max(0, time() - (int) $room['updated_at']) * 1000,
        'seats' => $seats,
        'yourSeat' => seatOf($room, $clientId),
        'hostIsYou' => $room['host_client'] === $clientId,
        'started' => $room['game'] !== null,
        'rules' => isset($room['rules']) && $room['rules'] !== null
            ? json_decode($room['rules'], true) : null,
        'game' => $room['game'],
        'emote' => isset($room['emote']) && $room['emote'] !== null
            ? json_decode($room['emote'], true) : null,
        'emoteN' => (int) ($room['emote_n'] ?? 0),
    ];
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

$app = AppFactory::create();
$app->addBodyParsingMiddleware();

// Reject oversized requests before the JSON parser touches them.
$app->add(function (Request $request, $handler): Response {
    $length = (int) $request->getHeaderLine('Content-Length');
    if ($length > MAX_BODY_BYTES) {
        $response = new \Slim\Psr7\Response(413);
        $response->getBody()->write(json_encode(['error' => 'Request too large.']));
        return $response->withHeader('Content-Type', 'application/json');
    }
    return $handler->handle($request);
});

// CORS: the client is served from GitHub Pages on another origin.
$app->add(function (Request $request, $handler): Response {
    $response = $handler->handle($request);
    return $response
        ->withHeader('Access-Control-Allow-Origin', '*')
        ->withHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        ->withHeader('Access-Control-Allow-Headers', 'Content-Type, X-Wahoo-Client')
        // Some hosts (e.g. DreamHost) inject long max-age defaults; polling
        // breaks the moment a snapshot gets cached, so forbid it explicitly.
        ->withHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
        ->withHeader('Pragma', 'no-cache')
        ->withHeader('Expires', '0');
});
$app->options('/{routes:.*}', fn (Request $request, Response $response) => $response);

// Uncaught exceptions become a bare JSON 500 — never a stack trace.
$errorMiddleware = $app->addErrorMiddleware(false, false, false);
$errorMiddleware->setDefaultErrorHandler(
    function (Request $request, Throwable $e) use ($app): Response {
        $status = $e instanceof \Slim\Exception\HttpException ? $e->getCode() : 500;
        $message = $e instanceof \Slim\Exception\HttpException ? $e->getMessage() : 'Server error.';
        $response = $app->getResponseFactory()->createResponse($status);
        $response->getBody()->write(json_encode(['error' => $message]));
        return $response
            ->withHeader('Content-Type', 'application/json')
            ->withHeader('Access-Control-Allow-Origin', '*');
    }
);

// A human visiting the API host lands on the game itself.
$app->get('/', fn (Request $request, Response $response) =>
    $response->withHeader('Location', GAME_URL)->withStatus(302));

// Create a room: the creator takes seat 0 and hosts.
$app->post('/api/rooms', function (Request $request, Response $response): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $name = sanitizeName($body['name'] ?? null);
    $token = is_string($body['token'] ?? null) ? substr($body['token'], 0, 64) : null;

    pruneIdleRooms($pdo);

    // A light per-IP throttle so a script can't flood the database.
    if (ipThrottled($pdo, $request, 'create', MAX_ROOMS_PER_IP_PER_HOUR)) {
        return errorResponse($response, 'Too many rooms created — try again later.', 429);
    }

    $code = newRoomCode($pdo);
    $clientId = bin2hex(random_bytes(12));
    $seats = [
        ['name' => $name, 'cpu' => false, 'clientId' => $clientId, 'token' => $token],
        null, null, null,
    ];
    $pdo->prepare('INSERT INTO rooms (code, seats, game, version, host_client, created_at, updated_at)
        VALUES (?, ?, NULL, 1, ?, ?, ?)')
        ->execute([$code, json_encode($seats), $clientId, time(), time()]);
    $pdo->prepare('INSERT INTO clients (id, room_code, name, token, last_seen) VALUES (?, ?, ?, ?, ?)')
        ->execute([$clientId, $code, $name, $token, time()]);

    $room = loadRoom($pdo, $code);
    return jsonResponse($response, ['clientId' => $clientId] + snapshot($room, $clientId));
});

// Join (or rejoin): reclaim a seat by token, take a free seat, or spectate.
$app->post('/api/rooms/{code}/join', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    pruneIdleRooms($pdo);
    // Codes are short dictionary words: throttle joins so bots can't scan rooms.
    if (ipThrottled($pdo, $request, 'join', MAX_JOINS_PER_IP_PER_HOUR)) {
        return errorResponse($response, 'Too many join attempts — try again later.', 429);
    }
    $pdo->beginTransaction();
    $room = loadRoom($pdo, $args['code']);
    if ($room === null) {
        $pdo->rollBack();
        return errorResponse($response, 'Room not found.', 404);
    }
    $body = (array) $request->getParsedBody();
    $name = sanitizeName($body['name'] ?? null);
    $token = is_string($body['token'] ?? null) ? substr($body['token'], 0, 64) : null;
    $clientId = bin2hex(random_bytes(12));

    $seatIndex = null;
    if ($token !== null) {
        foreach ($room['seats'] as $i => $seat) {
            if ($seat !== null && ($seat['token'] ?? null) === $token
                && (empty($seat['clientId']) || !empty($seat['cpu']))) {
                $seatIndex = $i; // welcome back
                break;
            }
        }
    }
    if ($seatIndex === null && $room['game'] === null) {
        $free = array_search(null, $room['seats'], true);
        $seatIndex = $free === false ? null : $free;
    }
    if ($seatIndex !== null) {
        $room['seats'][$seatIndex] = [
            'name' => $name, 'cpu' => false, 'clientId' => $clientId, 'token' => $token,
        ];
    }
    if ($room['host_client'] === null) {
        $room['host_client'] = $clientId;
    }
    $pdo->prepare('INSERT INTO clients (id, room_code, name, token, last_seen) VALUES (?, ?, ?, ?, ?)')
        ->execute([$clientId, $room['code'], $name, $token, time()]);
    saveRoom($pdo, $room);
    $pdo->commit();

    $room = loadRoom($pdo, $args['code']);
    return jsonResponse($response, ['clientId' => $clientId] + snapshot($room, $clientId));
});

// Poll for the room snapshot.
$app->get('/api/rooms/{code}', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $clientId = clientIdOf($request);
    $room = loadRoom($pdo, $args['code']);
    if ($room === null || clientRow($pdo, $clientId, $args['code']) === null) {
        return errorResponse($response, 'Room not found.', 404);
    }
    touchClient($pdo, $clientId);
    if (reapStaleClients($pdo, $room)) {
        $pdo->beginTransaction();
        saveRoom($pdo, $room);
        $pdo->commit();
        $room = loadRoom($pdo, $args['code']);
    }
    // Unchanged since the client's version: send a tiny heartbeat instead of
    // the full snapshot (~95% less polling traffic while idle). With wait=1
    // the request is held (a long poll) until a change or ~10s pass, so moves
    // reach other players almost immediately.
    $q = $request->getQueryParams();
    $since = $q['since'] ?? null;
    if (
        $since !== null && (int) $since === (int) $room['version']
        && ($q['wait'] ?? '') === '1'
    ) {
        $clientEmoteN = isset($q['emoteN']) ? (int) $q['emoteN'] : -1;
        $deadline = microtime(true) + 10;
        while (microtime(true) < $deadline) {
            usleep(300000);
            $room = loadRoom($pdo, $args['code']);
            if ($room === null) {
                return errorResponse($response, 'Room not found.', 404);
            }
            if ((int) $room['version'] !== (int) $since) {
                break;
            }
            if ($clientEmoteN >= 0 && (int) ($room['emote_n'] ?? 0) > $clientEmoteN) {
                break;
            }
        }
    }
    if ($since !== null && (int) $since === (int) $room['version']) {
        return jsonResponse($response, [
            'version' => (int) $room['version'],
            'ageMs' => max(0, time() - (int) $room['updated_at']) * 1000,
            'emote' => isset($room['emote']) && $room['emote'] !== null
                ? json_decode($room['emote'], true) : null,
            'emoteN' => (int) ($room['emote_n'] ?? 0),
        ]);
    }
    return jsonResponse($response, snapshot($room, $clientId));
});

// Fling a reaction at the table. No version bump and no updated_at touch:
// emotes must not restart the CPU-turn clock or re-trigger move animations.
$app->post('/api/rooms/{code}/emote', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $clientId = clientIdOf($request);
    $emoji = (string) ($body['emoji'] ?? '');
    $room = loadRoom($pdo, $args['code']);
    if ($room === null || clientRow($pdo, $clientId, $args['code']) === null) {
        return errorResponse($response, 'Room not found.', 404);
    }
    $seat = seatOf($room, $clientId);
    if ($seat === null || !in_array($emoji, EMOTES, true)) {
        return errorResponse($response, 'Not allowed.', 403);
    }
    // The finger can be banned from the table via house rules.
    if ($emoji === 'finger') {
        $rules = $room['game']['rules']
            ?? (isset($room['rules']) && $room['rules'] !== null ? json_decode($room['rules'], true) : null);
        if (is_array($rules) && ($rules['finger'] ?? true) === false) {
            return errorResponse($response, 'Not allowed.', 403);
        }
    }
    if (actionThrottled($pdo, $clientId)) {
        return errorResponse($response, 'Too fast.', 429);
    }
    touchClient($pdo, $clientId);
    $pdo->prepare('UPDATE rooms SET emote = ?, emote_n = emote_n + 1 WHERE code = ?')
        ->execute([json_encode(['seat' => $seat, 'emoji' => $emoji]), $room['code']]);
    $n = $pdo->prepare('SELECT emote_n FROM rooms WHERE code = ?');
    $n->execute([$room['code']]);
    return jsonResponse($response, ['ok' => true, 'emoteN' => (int) $n->fetchColumn()]);
});

// Rename yourself; works in the lobby and mid-game.
$app->post('/api/rooms/{code}/rename', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $clientId = clientIdOf($request);
    $pdo->beginTransaction();
    $room = loadRoom($pdo, $args['code']);
    if ($room === null || clientRow($pdo, $clientId, $args['code']) === null) {
        $pdo->rollBack();
        return errorResponse($response, 'Room not found.', 404);
    }
    $seat = seatOf($room, $clientId);
    if ($seat === null) {
        $pdo->rollBack();
        return errorResponse($response, 'Not seated.', 403);
    }
    if (actionThrottled($pdo, $clientId)) {
        $pdo->rollBack();
        return errorResponse($response, 'Too fast.', 429);
    }
    $room['seats'][$seat]['name'] = sanitizeName($body['name'] ?? null);
    touchClient($pdo, $clientId);
    saveRoom($pdo, $room);
    $pdo->commit();
    return jsonResponse($response, snapshot(loadRoom($pdo, $args['code']), $clientId));
});

// Host publishes the house rules for the upcoming game (display in lobbies).
$app->post('/api/rooms/{code}/rules', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $clientId = clientIdOf($request);
    $pdo->beginTransaction();
    $room = loadRoom($pdo, $args['code']);
    if ($room === null) {
        $pdo->rollBack();
        return errorResponse($response, 'Room not found.', 404);
    }
    if ($room['host_client'] !== $clientId || $room['game'] !== null) {
        $pdo->rollBack();
        return errorResponse($response, 'Not allowed.', 403);
    }
    $room['rules'] = json_encode(sanitizeRules($body['rules'] ?? null));
    touchClient($pdo, $clientId);
    saveRoom($pdo, $room);
    $pdo->commit();
    return jsonResponse($response, snapshot(loadRoom($pdo, $args['code']), $clientId));
});

// Change seats before the game starts.
$app->post('/api/rooms/{code}/sit', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $clientId = clientIdOf($request);
    $target = (int) ($body['seat'] ?? -1);
    $pdo->beginTransaction();
    $room = loadRoom($pdo, $args['code']);
    if ($room === null || clientRow($pdo, $clientId, $args['code']) === null) {
        $pdo->rollBack();
        return errorResponse($response, 'Room not found.', 404);
    }
    if ($room['game'] !== null || $target < 0 || $target > 3 || $room['seats'][$target] !== null) {
        $pdo->rollBack();
        return errorResponse($response, 'Seat unavailable.', 409);
    }
    $current = seatOf($room, $clientId);
    $entry = $current !== null
        ? $room['seats'][$current]
        : ['name' => 'Player', 'cpu' => false, 'clientId' => $clientId, 'token' => null];
    if ($current !== null) {
        $room['seats'][$current] = null;
    }
    $room['seats'][$target] = $entry;
    touchClient($pdo, $clientId);
    saveRoom($pdo, $room);
    $pdo->commit();
    return jsonResponse($response, snapshot(loadRoom($pdo, $args['code']), $clientId));
});

// Host adds or removes a CPU seat before the game starts.
$app->post('/api/rooms/{code}/cpu', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $clientId = clientIdOf($request);
    $target = (int) ($body['seat'] ?? -1);
    $on = (bool) ($body['on'] ?? false);
    $difficulty = in_array($body['difficulty'] ?? null, ['easy', 'medium', 'hard', 'insane'], true)
        ? $body['difficulty'] : 'medium';
    $pdo->beginTransaction();
    $room = loadRoom($pdo, $args['code']);
    if ($room === null) {
        $pdo->rollBack();
        return errorResponse($response, 'Room not found.', 404);
    }
    if ($room['host_client'] !== $clientId || $room['game'] !== null || $target < 0 || $target > 3) {
        $pdo->rollBack();
        return errorResponse($response, 'Not allowed.', 403);
    }
    if ($on && $room['seats'][$target] === null) {
        $room['seats'][$target] = cpuSeat(SEAT_COLOR_NAMES[$target], $difficulty);
    } elseif (!$on && $room['seats'][$target] !== null && !empty($room['seats'][$target]['cpu'])) {
        $room['seats'][$target] = null;
    }
    touchClient($pdo, $clientId);
    saveRoom($pdo, $room);
    $pdo->commit();
    return jsonResponse($response, snapshot(loadRoom($pdo, $args['code']), $clientId));
});

// Host starts the game with a client-generated initial state.
$app->post('/api/rooms/{code}/start', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $clientId = clientIdOf($request);
    $state = $body['state'] ?? null;
    $pdo->beginTransaction();
    $room = loadRoom($pdo, $args['code']);
    if ($room === null) {
        $pdo->rollBack();
        return errorResponse($response, 'Room not found.', 404);
    }
    if ($room['host_client'] !== $clientId || $room['game'] !== null) {
        $pdo->rollBack();
        return errorResponse($response, 'Only the host can start.', 403);
    }
    if (!looksLikeGameState($state)) {
        $pdo->rollBack();
        return errorResponse($response, 'Invalid game state.', 422);
    }
    foreach ($room['seats'] as $i => $seat) {
        if ($seat === null) {
            $room['seats'][$i] = cpuSeat(SEAT_COLOR_NAMES[$i]);
        }
    }
    $room['game'] = $state;
    touchClient($pdo, $clientId);
    saveRoom($pdo, $room);
    $pdo->commit();
    return jsonResponse($response, snapshot(loadRoom($pdo, $args['code']), $clientId));
});

// Host starts a rematch once a winner is decided.
$app->post('/api/rooms/{code}/again', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $clientId = clientIdOf($request);
    $state = $body['state'] ?? null;
    $pdo->beginTransaction();
    $room = loadRoom($pdo, $args['code']);
    if ($room === null) {
        $pdo->rollBack();
        return errorResponse($response, 'Room not found.', 404);
    }
    if ($room['host_client'] !== $clientId || $room['game'] === null || $room['game']['winner'] === null) {
        $pdo->rollBack();
        return errorResponse($response, 'No finished game to restart.', 403);
    }
    if (!looksLikeGameState($state)) {
        $pdo->rollBack();
        return errorResponse($response, 'Invalid game state.', 422);
    }
    $room['game'] = $state;
    touchClient($pdo, $clientId);
    saveRoom($pdo, $room);
    $pdo->commit();
    return jsonResponse($response, snapshot(loadRoom($pdo, $args['code']), $clientId));
});

// Post the state that results from a move. Turn order is enforced here:
// your own turn, or anyone may act for a CPU seat once it's due.
$app->post('/api/rooms/{code}/state', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $clientId = clientIdOf($request);
    $expected = (int) ($body['expectedVersion'] ?? -1);
    $forCpu = (bool) ($body['cpu'] ?? false);
    $state = $body['state'] ?? null;
    $pdo->beginTransaction();
    $room = loadRoom($pdo, $args['code']);
    if ($room === null || clientRow($pdo, $clientId, $args['code']) === null) {
        $pdo->rollBack();
        return errorResponse($response, 'Room not found.', 404);
    }
    if ($room['game'] === null || $room['game']['winner'] !== null) {
        $pdo->rollBack();
        return errorResponse($response, 'No game in progress.', 409);
    }
    if ((int) $room['version'] !== $expected) {
        $pdo->rollBack();
        return errorResponse($response, 'Version conflict.', 409);
    }
    $actingSeat = (int) $room['game']['current'];
    $seatEntry = $room['seats'][$actingSeat] ?? null;
    if ($forCpu) {
        $seatIsCpu = $seatEntry === null || !empty($seatEntry['cpu']);
        if (!$seatIsCpu) {
            $pdo->rollBack();
            return errorResponse($response, 'That seat is not a CPU.', 403);
        }
    } elseif (seatOf($room, $clientId) !== $actingSeat) {
        $pdo->rollBack();
        return errorResponse($response, 'Not your turn.', 403);
    }
    if (!looksLikeGameState($state)) {
        $pdo->rollBack();
        return errorResponse($response, 'Invalid game state.', 422);
    }
    $room['game'] = $state;
    touchClient($pdo, $clientId);
    saveRoom($pdo, $room);
    $pdo->commit();
    return jsonResponse($response, snapshot(loadRoom($pdo, $args['code']), $clientId));
});

// Leave: vacate pre-game, or hand the seat to a CPU mid-game.
$app->post('/api/rooms/{code}/leave', function (Request $request, Response $response, array $args): Response {
    $pdo = db();
    $body = (array) $request->getParsedBody();
    $clientId = clientIdOf($request);
    $pdo->beginTransaction();
    $room = loadRoom($pdo, $args['code']);
    if ($room === null) {
        $pdo->rollBack();
        return jsonResponse($response, ['ok' => true]);
    }
    $seat = seatOf($room, $clientId);
    if ($seat !== null) {
        $entry = $room['seats'][$seat];
        if ($room['game'] !== null && $room['game']['winner'] === null) {
            $room['seats'][$seat] = cpuSeat($entry['name'], 'medium', $entry['token'] ?? null);
        } else {
            $room['seats'][$seat] = null;
        }
    }
    if ($room['host_client'] === $clientId) {
        $room['host_client'] = null;
    }
    $pdo->prepare('DELETE FROM clients WHERE id = ?')->execute([$clientId]);
    reapStaleClients($pdo, $room);
    saveRoom($pdo, $room);
    $pdo->commit();
    return jsonResponse($response, ['ok' => true]);
});

$app->run();
