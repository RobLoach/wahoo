<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/** `composer reset` removes the database and its WAL sidecars. */
final class ResetTest extends TestCase
{
    public function testRemovesTheDatabaseAndSidecars(): void
    {
        $db = tempnam(sys_get_temp_dir(), 'wahoo-reset-');
        file_put_contents("$db-wal", 'wal');
        file_put_contents("$db-shm", 'shm');

        exec(
            'WAHOO_DB=' . escapeshellarg($db) . ' php ' . escapeshellarg(__DIR__ . '/../bin/reset.php') . ' 2>&1',
            $out,
            $code,
        );

        $this->assertSame(0, $code, implode("\n", $out));
        $this->assertFileDoesNotExist($db);
        $this->assertFileDoesNotExist("$db-wal");
        $this->assertFileDoesNotExist("$db-shm");
    }

    public function testIsANoOpWithoutADatabase(): void
    {
        exec(
            'WAHOO_DB=/tmp/wahoo-definitely-missing.sqlite php '
                . escapeshellarg(__DIR__ . '/../bin/reset.php') . ' 2>&1',
            $out,
            $code,
        );
        $this->assertSame(0, $code);
        $this->assertStringContainsString('Nothing to reset', implode("\n", $out));
    }
}
