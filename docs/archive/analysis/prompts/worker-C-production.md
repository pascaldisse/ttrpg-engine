FIRST read `/Users/pascaldisse/projects/ttrpg/analysis/00-context-brief.md` in full — it explains OUR project,
the source to mine, and the caveats. Your working dir is `~/projects/instantale-mac`.

YOUR SLICE: **Production & atmosphere — image generation, audio/music, screen/UX flow, and any combat/mode switch.**
This is OUR web prototype's explicit focus ("atmosphere, not features"), so be thorough.

Read (in this order): `notes/IMAGE-GEN-PLAN.md`, `notes/GAME-FLOW-SPEC.md`, then `src/imagegen/`, `src/screens/`,
`src/ui/`, `src/assets/`, `src/assets.py`. Peek at the asset tree layout with `ls -R assets | head -120` (don't open
binaries). Use `src/` as ground truth.

Answer concretely:
1. **Image generation:** which API/model? How is the image prompt constructed (from location? scene? narration?)?
   When are images triggered? **How is visual CONSISTENCY/continuity maintained across a session** — style anchors,
   fixed style strings, seeds, reference images, per-world art direction? Caching of generated images?
2. **Audio/music:** is music/sound generated or curated/bundled? How is it selected (per-world, per-location,
   per-mood)? Any dynamic/adaptive audio? List what's in the asset sound tree.
3. **Screen/scene flow & UX:** enumerate the screens (title → world select → play → …) and the in-play layout
   (where narration, image, choices, input sit). What UI framework is used?
4. **Combat / mode switching:** is there a combat mode or any switch between exploration and another mode? If yes,
   how does the handoff work? If no, say so.
5. Map onto OUR atmosphere-first web prototype (consistent image-gen across a session, AI + curated music,
   mood control as a DM-seat knob). What techniques to steal, what desktop-only assumptions won't port to web.

Deliver: write full technical findings — file paths, the image-prompt construction recipe, and the (A) how /
(B) overlap / (C) differs-or-lacks / (D) steal-this-for-web + don't-copy structure — to
`/Users/pascaldisse/projects/ttrpg/analysis/instantale-production.md`. Return only a compact 6–10 bullet summary.
