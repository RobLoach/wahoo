// ---------------------------------------------------------------------------
// The victory overlay: winners, stat tiles, confetti, and the rematch series.
// ---------------------------------------------------------------------------
import { $, esc } from './dom.ts';
import { PLAYER_COLORS_CSS } from './palette.ts';
import type { View } from '../net/protocol.ts';
import { inked, shortName } from './cards.ts';

export class VictoryView {
  private shown = false;
  private counted = false;
  /** Team wins across "Play again" rematches this session. */
  private series: [number, number] = [0, 0];

  /** A fresh session (entered from the menu) starts a fresh series. */
  reset() {
    this.series = [0, 0];
  }

  render(view: View, online: boolean, isHost: boolean) {
    const overlay = $('#victory');
    if (view.winner === null) {
      overlay.hidden = true;
      this.shown = false;
      this.counted = false;
      overlay.querySelectorAll('.confetti').forEach(c => c.remove());
      return;
    }
    if (!this.counted) {
      this.counted = true;
      this.series[view.winner]++;
    }
    $('#btn-again').hidden = online && !isHost;
    const seats = view.winner === 0 ? [0, 2] : [1, 3];
    $('#victory-rule').className = `paper-rule rule-team${view.winner}`;
    $('#victory-title').innerHTML = `${inked(view, seats[0])} &amp; ${inked(view, seats[1])} win`;
    const teamStomps = seats.reduce((s, i) => s + view.stats.stomps[i], 0);
    const totalFolds = view.stats.folds.reduce((a, b) => a + b, 0);
    const most = view.stats.stomps.indexOf(Math.max(...view.stats.stomps));
    const stat = (value: string, label: string) =>
      `<div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
    const gamesPlayed = this.series[0] + this.series[1];
    $('#victory-stats').innerHTML =
      stat(String(view.round), view.round === 1 ? 'Round' : 'Rounds') +
      stat(String(teamStomps), 'Stomps') +
      stat(String(totalFolds), totalFolds === 1 ? 'Fold' : 'Folds') +
      (view.stats.stomps[most] > 0 ? stat(esc(shortName(view, most)), 'Most stomps') : '') +
      (gamesPlayed > 1 ? stat(`${this.series[0]}–${this.series[1]}`, 'Series') : '');
    overlay.hidden = false;
    if (!this.shown) {
      this.shown = true;
      const colors = view.winner === 0
        ? [PLAYER_COLORS_CSS[0], PLAYER_COLORS_CSS[2]]
        : [PLAYER_COLORS_CSS[1], PLAYER_COLORS_CSS[3]];
      for (let i = 0; i < 50; i++) {
        const bit = document.createElement('span');
        bit.className = 'confetti';
        bit.style.left = `${Math.random() * 100}%`;
        bit.style.background = colors[i % 2];
        bit.style.animationDuration = `${2.2 + Math.random() * 2.4}s`;
        bit.style.animationDelay = `${Math.random() * 1.6}s`;
        overlay.appendChild(bit);
      }
    }
  }
}
