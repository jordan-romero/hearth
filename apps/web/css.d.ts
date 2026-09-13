// TS 6 (TS2882) requires a declaration for side-effect imports like `import "./globals.css"`.
// Next generates next-env.d.ts with its own references, but that file is gitignored — so CI,
// which never runs `next dev`/`next build` before typecheck, has nothing declaring CSS.
declare module "*.css";
