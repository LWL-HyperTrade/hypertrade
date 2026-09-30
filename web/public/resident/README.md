# Resident avatar assets

Served as static files by Vite. Referenced from `web/src/ui/resident/vrmScene.ts`
and `web/src/lib/residents.ts`. Spec: `docs/RESIDENTS.md`.

```text
public/resident/
  anims/
    dance.vrma                 # Yuna — loops while the book is green (smug)
    dance-2.vrma               # Selene — same
    idle.vrma  modelpose.vrma  # waiting pool (not in profit)
    spin.vrma  vsign.vrma  gunshoot.vrma
  presets/
    yuna/       yuna.vrm      poster.webp
    selene/     selene.vrm    poster.webp
    julian/     julian.vrm    poster.png
    kuri/       kiba.vrm      poster.png
    mika/       mika.vrm      poster.png
    sebastian/  sebastian.vrm poster.png
    atlas/      atlas.vrm     poster.webp
    nova/       nova.vrm      poster.webp
    sol/        sol.vrm       poster.webp
```

- **`.vrma` only** (glTF + `VRMC_vrm_animation`). Unity `.anim` will not play.
  Export from UniVRM / Blender VRM add-on. Loop-friendly clips of a few seconds.
- **In profit** (`smug`): that preset's dance on a loop, plus the happy face.
- **Waiting** (idle / focused / tense / shrug / **sleep**): the stage shuffles that look's
  pool at random, never repeating the same clip twice in a row — including when
  no agent is live, so visitors still see motion. Females and neutrals use every
  waiting clip. Males use `spin` instead of `idle`, and skip `modelpose`. The Resting badge stays; eyes
  stay open while a clip is playing.
- Bind / T-pose rest is not used as a visible pose.
- **`{id}.vrm`** — VRM 0.x or 1.0, ≤ 15 MB, textures ≤ 2048px. Face the +Z axis
  (VRM 0.x is auto-rotated).
- **`poster.webp`** — first frame, transparent background, ~800×1000. Shown before the
  model loads and whenever WebGL is unavailable / reduced-motion is on.

Preset ids must match `AVATAR_PRESETS` in `backend/tenant_residents.py` and
`web/src/lib/residents.ts`. Binary assets are licensed separately. The old `luna`
id still resolves to `yuna`.
