# Wesync: Honeybee Pixel Theme

A cottagecore pixel-art theme for Wesync, a live listening room. It uses cream and honey colors, thick brown outlines, and a pixel gramophone with a spinning disc.

All colors are CSS variables defined in `:root` in `style.css`. Styles should reference the variable names listed in the Usage column rather than raw hex codes.

## Main Color Palette

| Name         | Hex Code  | Usage                                                  |
| ------------ | --------- | ------------------------------------------------------ |
| Cream Meadow | `#F6E4B4` | Background and base color (`--bg`)                     |
| Honey Gold   | `#F7B731` | Primary buttons, play button, progress bar (`--honey`) |
| Hive Brown   | `#5A2D0C` | Text, outlines, hard shadows (`--ink`, `--text`)       |
| Comb Cream   | `#FFF4D2` | Cards, secondary buttons, player (`--surface`)         |
| Clay Tan     | `#DDA66A` | Top and bottom bands, dotted dividers (`--band`)       |
| Blossom Pink | `#F29A8E` | Small accents, bee cheek, floating notes (`--pink`)    |
| Brass Gold   | `#D6AA4E` | Gramophone body, disc center hole                      |
| Berry Red    | `#B3261E` | Error text, invalid inputs (`--danger`)                |

## Sub Colors

| Base Color   | Sub Color Name | Hex Code  | Usage                                                                |
| ------------ | -------------- | --------- | -------------------------------------------------------------------- |
| Cream Meadow | Butter Cream   | `#FBE3A0` | Hovered rows and cards, bevel shading (`--surface-2`)                |
|              | Soft Parchment | `#FFFBE8` | Input background, bevel highlight                                    |
|              | Sprout Cream   | `#ECD193` | Sprout pattern on the page background                                |
| Honey Gold   | Sunbeam        | `#FFD966` | Button highlight, now-playing track row (`--honey-light`)            |
|              | Honey Glow     | `#FFC94D` | Button hover                                                         |
|              | Amber Honey    | `#D9861A` | Button shadow edge, pressed state, progress stripes (`--honey-dark`) |
|              | Bee Yellow     | `#FFC83D` | Bee sprite body                                                      |
|              | Stripe Orange  | `#C46A14` | Bee sprite stripes                                                   |
| Hive Brown   | Bark Brown     | `#8A5A2B` | Muted text: artist names, timestamps, labels (`--text-muted`)        |
|              | Vinyl Brown    | `#3D2410` | Default disc when a song has no cover                                |
|              | Groove Brown   | `#5C3A1C` | Record grooves on the default disc                                   |
| Comb Cream   | Wax White      | `#FFFFFF` | Focused input background                                             |
|              | Warm Hover     | `#FFF0C4` | Card hover background                                                |
| Clay Tan     | Kraft Sand     | `#F0CF7C` | Secondary button hover shading                                       |
| Blossom Pink | Blush Red      | `#F5B5AE` | Error glow around invalid inputs                                     |
| Brass Gold   | Polished Brass | `#EECD6E` | Gramophone top plate                                                 |
|              | Horn Gold      | `#F4D678` | Gramophone horn                                                      |
|              | Shaded Brass   | `#B08234` | Gramophone side shading                                              |

## Fonts

| Role     | Font          | Weights       | Usage                                                         |
| -------- | ------------- | ------------- | ------------------------------------------------------------- |
| Headings | Pixelify Sans | 500, 600, 700 | Headings, buttons, song titles, LCD screen (`--font-heading`) |
| Body     | VT323         | 400           | Paragraphs, inputs, artist names, timestamps (`--font-body`)  |

Both fonts are available from Google Fonts under the SIL Open Font License. VT323 renders small, so the base text size is `1.3rem`.

## Pixel Sprites and Patterns

| Name           | Class or Variable                           | Usage                                      |
| -------------- | ------------------------------------------- | ------------------------------------------ |
| Bee            | `.spr .spr-bee`                             | Logo, now-playing marker in the track list |
| Honey Cell     | `.spr .spr-cell`                            | Album art placeholder                      |
| Flower         | `.spr .spr-flower`                          | Decoration                                 |
| Gramophone     | `.stage` with `--spr-gramo` and `--spr-arm` | The player                                 |
| Music Notes    | `.note`, `.note.n2`                         | Float out of the horn while a song plays   |
| Sprout Pattern | `--pat-sprout`                              | Page background                            |
| Striped Band   | `--pat-band`                                | Top and bottom edge of the page            |

Sprites should be scaled by whole numbers (2x, 3x, 4x) so the pixels stay even.

## Files

| File            | Purpose                                                   |
| --------------- | --------------------------------------------------------- |
| `index.html`    | Page layout (room form and player)                        |
| `style.css`     | Theme, components, gramophone, layout                     |
| `app.js`        | Room, socket, and audio sync logic                        |
| `visualizer.js` | Spinning disc, floating notes, cover picker, slider fills |

The rule `[hidden] { display: none !important; }` must remain at the top of `style.css`. The player stays hidden until the user is in a room.
