// ---------------------------------------------------------------------------
// House rules: the shared menu card, its persistence, and every place the
// chosen rules are described in words.
// ---------------------------------------------------------------------------
import { $ } from './dom.ts';
import { DEFAULT_RULES } from '../engine/types.ts';
import type { HouseRules } from '../engine/types.ts';

export function savedRules(): HouseRules {
  try {
    return { ...DEFAULT_RULES, ...JSON.parse(localStorage.getItem('wahoo-rules') ?? '{}') };
  } catch {
    return { ...DEFAULT_RULES };
  }
}

const SEVEN_TEXT = {
  1: 'one bunny only',
  2: 'may split across two bunnies',
  4: 'may split freely',
} as const;

/** One source of truth for describing the rules, everywhere they appear. */
export function ruleLines(r: HouseRules): [string, string][] {
  return [
    ['Stomping teammates', r.friendlyFire ? 'allowed' : 'not allowed'],
    ['The 7', SEVEN_TEXT[r.sevenMaxBunnies]],
    ['Jumping over occupied burrow slots', r.burrowJump ? 'allowed' : 'not allowed'],
    ['The finger reaction', r.finger !== false ? 'allowed' : 'banned at this table'],
  ];
}

/** The compact one-liner shown in lobbies. */
export function describeRules(r: HouseRules): string {
  return [
    r.friendlyFire ? 'teammate stomping allowed' : 'no teammate stomping',
    { 1: '7 moves one bunny', 2: '7 splits up to two bunnies', 4: '7 splits freely' }[
      r.sevenMaxBunnies
    ],
    r.burrowJump ? 'burrow jumping allowed' : 'no burrow jumping',
    r.finger === false ? 'no finger reaction' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The "House Rules in this game" list inside the in-game rules modal. */
export function renderModalHouseRules(r: HouseRules) {
  $('#rules-modal-house').innerHTML = ruleLines(r)
    .map(([label, value]) => `<li>${label}: <b>${value}</b></li>`)
    .join('');
}

function rulesControlsHtml(): string {
  const r = savedRules();
  return (
    `<label class="rule-row"><input type="checkbox" id="hr-ff" ${r.friendlyFire ? 'checked' : ''}/>` +
    `<span>Kings and landings can stomp teammates</span></label>` +
    `<label class="rule-row"><span>The 7</span><select id="hr-seven">` +
    `<option value="1" ${r.sevenMaxBunnies === 1 ? 'selected' : ''}>one bunny only</option>` +
    `<option value="2" ${r.sevenMaxBunnies === 2 ? 'selected' : ''}>up to two bunnies</option>` +
    `<option value="4" ${r.sevenMaxBunnies === 4 ? 'selected' : ''}>any split</option>` +
    `</select></label>` +
    `<label class="rule-row"><input type="checkbox" id="hr-jump" ${r.burrowJump ? 'checked' : ''}/>` +
    `<span>Bunnies may jump over occupied burrow slots</span></label>` +
    `<label class="rule-row"><input type="checkbox" id="hr-finger" ${r.finger !== false ? 'checked' : ''}/>` +
    `<span>Allow the finger reaction</span></label>`
  );
}

/** Read the card's current values (persisting them as the new defaults). */
export function readRules(): HouseRules {
  const rules: HouseRules = {
    friendlyFire: ($('#hr-ff') as HTMLInputElement).checked,
    sevenMaxBunnies: Number(($('#hr-seven') as HTMLSelectElement).value) as 1 | 2 | 4,
    burrowJump: ($('#hr-jump') as HTMLInputElement).checked,
    finger: ($('#hr-finger') as HTMLInputElement).checked,
  };
  localStorage.setItem('wahoo-rules', JSON.stringify(rules));
  return rules;
}

/** Populate the House Rules card and report every change. */
export function initHouseRules(onChange: (rules: HouseRules) => void) {
  $('#house-rules-body').innerHTML = rulesControlsHtml();
  $('#house-rules-body')
    .querySelectorAll('input, select')
    .forEach(el => el.addEventListener('change', () => onChange(readRules())));
}
