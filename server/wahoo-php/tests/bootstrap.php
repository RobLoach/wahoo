<?php

declare(strict_types=1);

// Pull in the server's functions without running the Slim app, against a
// throwaway in-memory database.
define('WAHOO_TEST', true);
putenv('WAHOO_DB=:memory:');
require __DIR__ . '/../index.php';
