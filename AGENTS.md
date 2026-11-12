# Car Theft labs

Procedural generation experiments for *Car Theft: Auckland*, a browser driving game. This branch (`labs`) is an
orphan and is never merged.

Don't read the game's code: no `main` or other branches, no other worktrees or clones on disk.

Use TypeScript, Three.js and Vite, so results can be ported into the game later.

```sh
npm ci
npm run dev     # dev server, reachable from phones on the LAN
npm run build   # typecheck + build into dist/
```

Every push to `labs` deploys to https://labs.cartheft.pages.dev/.
