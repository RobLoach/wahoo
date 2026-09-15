#!/usr/bin/env php
<?php

/**
 * Wipe the relay's database — rooms, seats, tokens, throttles. The schema
 * is recreated automatically on the next request.
 *
 * CLI only; run over SSH:  composer reset   (or: php bin/reset.php)
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit(1);
}

$file = getenv('WAHOO_DB');
if ($file === false || $file === '') {
    $file = __DIR__ . '/../data/wahoo.sqlite';
}

$removed = [];
$failed = [];
// WAL mode keeps recent writes in the sidecar files: remove all three or
// deleted rooms can resurrect from the log.
foreach ([$file, "$file-wal", "$file-shm"] as $f) {
    if (!is_file($f)) {
        continue;
    }
    if (unlink($f)) {
        $removed[] = basename($f);
    } else {
        $failed[] = basename($f);
    }
}

if ($failed !== []) {
    fwrite(STDERR, 'Could not remove: ' . implode(', ', $failed) . "\n");
    exit(1);
}
echo $removed === []
    ? "Nothing to reset: no database at $file.\n"
    : 'Removed ' . implode(', ', $removed) . "; a fresh database appears on the next request.\n";
