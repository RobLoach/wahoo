<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/** Staleness probing and reaping against the in-memory database. */
final class ReapingTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = db();
        $this->pdo->exec('DELETE FROM clients');
    }

    private function addClient(string $id, int $ageSeconds): void
    {
        $this->pdo->prepare('INSERT INTO clients (id, room_code, name, token, last_seen) VALUES (?, ?, ?, NULL, ?)')
            ->execute([$id, 'TEST', 'N', time() - $ageSeconds]);
    }

    public function testFreshClientIdsSplitsFreshFromStale(): void
    {
        $this->addClient('fresh', 0);
        $this->addClient('stale', CLIENT_STALE_SECONDS + 30);
        $fresh = freshClientIds($this->pdo, ['fresh', 'stale', 'ghost']);
        $this->assertArrayHasKey('fresh', $fresh);
        $this->assertArrayNotHasKey('stale', $fresh);
        $this->assertArrayNotHasKey('ghost', $fresh);
        $this->assertSame([], freshClientIds($this->pdo, []));
    }

    public function testSeatsNeedReapingProbes(): void
    {
        $this->addClient('a', 0);
        $seats = [['name' => 'A', 'clientId' => 'a'], null, cpuSeat('Green'), null];
        $this->assertFalse(seatsNeedReaping($this->pdo, $seats, 'a'));
        // A missing host always needs the full path.
        $this->assertTrue(seatsNeedReaping($this->pdo, $seats, null));
        // A seated human with no fresh row is stale.
        $gone = [['name' => 'B', 'clientId' => 'vanished'], null, null, null];
        $this->assertTrue(seatsNeedReaping($this->pdo, $gone, 'a'));
    }

    public function testReapTurnsStaleHumansIntoCpusMidGame(): void
    {
        $this->addClient('here', 0);
        $room = [
            'code' => 'TEST',
            'seats' => [
                ['name' => 'Here', 'cpu' => false, 'clientId' => 'here', 'token' => 't1'],
                ['name' => 'Gone', 'cpu' => false, 'clientId' => 'gone', 'token' => 't2'],
                null,
                null,
            ],
            'game' => ['winner' => null],
            'host_client' => 'gone',
        ];
        $this->assertTrue(reapStaleClients($this->pdo, $room));
        // Mid-game the vanished player becomes a CPU and keeps the reclaim token.
        $this->assertTrue($room['seats'][1]['cpu']);
        $this->assertSame('t2', $room['seats'][1]['token']);
        // The fresh player is untouched and inherits the host seat.
        $this->assertFalse($room['seats'][0]['cpu']);
        $this->assertSame('here', $room['host_client']);
    }

    public function testReapVacatesSeatsWhenNoGameRuns(): void
    {
        $room = [
            'code' => 'TEST',
            'seats' => [['name' => 'Gone', 'cpu' => false, 'clientId' => 'gone', 'token' => null], null, null, null],
            'game' => null,
            'host_client' => null,
        ];
        $this->assertTrue(reapStaleClients($this->pdo, $room));
        $this->assertNull($room['seats'][0]);
    }
}
