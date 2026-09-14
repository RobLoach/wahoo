<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class HelpersTest extends TestCase
{
    /** A minimal blob that passes looksLikeGameState. */
    private function validState(): array
    {
        return [
            'bunnies' => array_fill(0, 16, ['id' => 0]),
            'players' => array_fill(0, 4, ['hand' => []]),
            'drawPile' => [],
            'discard' => [],
            'current' => 0,
            'winner' => null,
            'log' => ['Red plays 3♠.'],
        ];
    }

    public function testSanitizeNameStripsMarkupAndBounds(): void
    {
        $this->assertSame('scriptalert(', sanitizeName('<script>alert(1)</script>'));
        $this->assertSame('Player', sanitizeName(''));
        $this->assertSame('Player', sanitizeName(null));
        $this->assertSame(12, mb_strlen(sanitizeName(str_repeat('x', 40))));
    }

    public function testSanitizeRulesKeepsOnlyKnownValues(): void
    {
        $this->assertSame(
            [
                'friendlyFire' => true, 'sevenMaxBunnies' => 2, 'burrowJump' => false,
                'finger' => true, 'cpuSnappy' => false, 'turnTimer' => 0,
            ],
            sanitizeRules('nonsense'),
        );
        $rules = sanitizeRules([
            'friendlyFire' => false,
            'sevenMaxBunnies' => 4,
            'burrowJump' => 'yes please', // wrong type: ignored
            'turnTimer' => 45,            // not a preset: ignored
            'cpuSnappy' => true,
            'bogus' => 1,
        ]);
        $this->assertFalse($rules['friendlyFire']);
        $this->assertSame(4, $rules['sevenMaxBunnies']);
        $this->assertFalse($rules['burrowJump']);
        $this->assertSame(0, $rules['turnTimer']);
        $this->assertTrue($rules['cpuSnappy']);
        $this->assertArrayNotHasKey('bogus', $rules);
    }

    public function testLooksLikeGameStateAcceptsAValidBlob(): void
    {
        $this->assertTrue(looksLikeGameState($this->validState()));
    }

    public function testLooksLikeGameStateRejectsBadShapes(): void
    {
        $this->assertFalse(looksLikeGameState('not an array'));
        $this->assertFalse(looksLikeGameState([]));

        $wrongBunnies = $this->validState();
        $wrongBunnies['bunnies'] = array_fill(0, 15, []);
        $this->assertFalse(looksLikeGameState($wrongBunnies));

        $badCurrent = $this->validState();
        $badCurrent['current'] = 7;
        $this->assertFalse(looksLikeGameState($badCurrent));

        $noWinnerKey = $this->validState();
        unset($noWinnerKey['winner']);
        $this->assertFalse(looksLikeGameState($noWinnerKey));

        // A null winner is legitimate; 2 is not a team.
        $badWinner = $this->validState();
        $badWinner['winner'] = 2;
        $this->assertFalse(looksLikeGameState($badWinner));
    }

    public function testLooksLikeGameStateBoundsTheLog(): void
    {
        $longLine = $this->validState();
        $longLine['log'] = [str_repeat('x', 401)];
        $this->assertFalse(looksLikeGameState($longLine));

        $bigEvent = $this->validState();
        $bigEvent['log'] = [['t' => 'play', 'pad' => str_repeat('x', 220)]];
        $this->assertFalse(looksLikeGameState($bigEvent));

        $okEvent = $this->validState();
        $okEvent['log'] = [['t' => 'play', 'seat' => 0]];
        $this->assertTrue(looksLikeGameState($okEvent));

        $tooMany = $this->validState();
        $tooMany['log'] = array_fill(0, 2001, 'x');
        $this->assertFalse(looksLikeGameState($tooMany));
    }

    public function testSeatOfFindsTheSeatByClientId(): void
    {
        $room = ['seats' => [
            null,
            ['name' => 'A', 'clientId' => 'abc'],
            ['name' => 'B', 'clientId' => null],
            cpuSeat('Yellow'),
        ]];
        $this->assertSame(1, seatOf($room, 'abc'));
        $this->assertNull(seatOf($room, 'nope'));
    }

    public function testCpuSeatDefaultsToHard(): void
    {
        $this->assertSame('hard', cpuSeat('Green')['difficulty']);
    }
}
