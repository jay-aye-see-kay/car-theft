# Car Theft labs

Procedural generation experiments for Car Theft: Auckland. An orphan branch that is never merged; see `AGENTS.md`.
Live: https://labs.cartheft.pages.dev/

## Data

Labs load a baked tile from `public/tiles/`. To rebuild it from source data:

```sh
npm run fetch   # OpenStreetMap + LINZ 1 m LiDAR into .cache/ (no API key)
npm run bake    # interpret into public/tiles/<id>/model.json + height.bin
```

Data: OpenStreetMap contributors (ODbL); LINZ elevation, Auckland 2024 (CC BY 4.0).
