import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * 開発中は API(:3000)への通信を中継し、Web と API を同じオリジンにする。
 * リフレッシュトークンの Cookie(SameSite=Strict)をそのまま使え、CORS の設定も要らない。
 * 本番も同じドメインで配信する(/trpc と /files を API へ)
 */
const api = process.env.API_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/trpc": api, "/files": api },
  },
});
