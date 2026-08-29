# 🐰 Wahoo

A 4-player team race board game built with [Pixi.js](https://pixijs.com). Two teams
of two maneuver their bunnies around the track and into their safe burrows —
stomping anyone who gets in the way.

**Play it:** https://robloach.github.io/wahoo/

## Features

- **Hot seat** — any mix of humans and CPU players on one device.
- **CPU players** — heuristic AI opponents.
- **Online play** — WebSocket rooms with shareable 4-letter codes. Empty seats
  are filled by CPUs; if a player disconnects mid-game a CPU takes over.

## The rules in brief

- Teams sit opposite each other: **Red & Green** vs **Blue & Yellow**. First team
  to house all 8 combined bunnies in their burrows wins.
- Each round every player is dealt 4 cards. On your turn play one card and do
  what it says (no drawing back up). If nothing in your hand is playable you
  discard your hand and sit out the round.
- Landing on any bunny stomps it back to its owner's reserve. Passing through
  doesn't stomp.
- **A / 2** spawn a bunny at Position 1 or move 1/2 (a 2 also flips a bonus card
  from the draw pile which you play too). **4** moves backward, and can back a
  bunny straight into its burrow. **7** splits seven forward steps across your
  bunnies. **J** swaps one of your bunnies with any other active bunny. **Q**
  moves 12. **K** spawns onto any other bunny — even a teammate's — stomping it, or moves 13.
  Everything else moves its face value.
- Burrow entry needs an exact count, with no jumping inside the burrow: every
  slot passed through must be open. Once inside, bunnies are immune to
  everything.
- Once your own 4 bunnies are home, you keep receiving cards and move your
  teammate's bunnies on your turn.

## Development

```sh
npm install
npm run dev      # local dev server
npm test         # rules engine tests (vitest)
npm run build    # production build to dist/
```

## Online play server

GitHub Pages only hosts the static client. To play online, someone needs to run
the game server (Node ≥ 23.6):

```sh
npm run server           # listens on ws://localhost:8787
PORT=9000 npm run server
```

Then in the client's **Online Game** panel, enter the server address (for a
server behind HTTPS use `wss://…`), create a room, and share the room code.

## Deployment

Pushes to `main` build and deploy the client to GitHub Pages via
`.github/workflows/deploy.yml`.
