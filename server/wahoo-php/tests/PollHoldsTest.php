<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/** Long-poll slots: one per seat in a room, with a global ceiling. */
final class PollHoldsTest extends TestCase
{
    private PDO $pdo;

    protected function setUp(): void
    {
        $this->pdo = db();
        $this->pdo->exec('DELETE FROM poll_holds');
    }

    public function testARoomHoldsAtMostFour(): void
    {
        $held = [];
        for ($i = 0; $i < MAX_HELD_POLLS_PER_ROOM; $i++) {
            $held[] = acquirePollHold($this->pdo, 'AAAA');
        }
        $this->assertNotContains(null, $held);
        $this->assertNull(acquirePollHold($this->pdo, 'AAAA'));
        // Another room still gets slots of its own.
        $this->assertNotNull(acquirePollHold($this->pdo, 'BBBB'));
    }

    public function testTheGlobalCeilingProtectsThePool(): void
    {
        $rooms = ['AAAA', 'BBBB', 'CCCC'];
        foreach ($rooms as $room) {
            for ($i = 0; $i < MAX_HELD_POLLS_PER_ROOM; $i++) {
                $this->assertNotNull(acquirePollHold($this->pdo, $room));
            }
        }
        // 12 workers held: a fourth room must not add a thirteenth.
        $this->assertNull(acquirePollHold($this->pdo, 'DDDD'));
    }

    public function testReleaseFreesTheSlot(): void
    {
        for ($i = 0; $i < MAX_HELD_POLLS_PER_ROOM - 1; $i++) {
            acquirePollHold($this->pdo, 'AAAA');
        }
        $last = acquirePollHold($this->pdo, 'AAAA');
        $this->assertNull(acquirePollHold($this->pdo, 'AAAA'));
        releasePollHold($this->pdo, $last);
        $this->assertNotNull(acquirePollHold($this->pdo, 'AAAA'));
    }
}
