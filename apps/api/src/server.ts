import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { loadConfig } from "./config.js";
import { serveImage } from "./images.js";
import { appRouter } from "./router.js";
import { createServices } from "./services.js";

const port = Number(process.env.PORT ?? 3000);
const config = loadConfig();
const services = createServices(config);

const trpc = createHTTPHandler({
  basePath: "/trpc/",
  // カード登録で撮影画像(表裏 各 3MB まで、base64)を受け取るため
  maxBodySize: 12 * 1024 * 1024,
  router: appRouter,
  createContext: ({ req }) => {
    const header = req.headers.authorization;
    const accessToken = header?.startsWith("Bearer ") ? header.slice(7) : null;
    return { requestId: randomUUID(), services, accessToken, ip: req.socket.remoteAddress ?? null };
  },
});

const IMAGE_PATH = /^\/files\/images\/([A-Za-z0-9_.-]{20,2000})$/;

createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0]!;
  const m = IMAGE_PATH.exec(path);
  if (req.method === "GET" && m && services) {
    serveImage(services, m[1]!).then(
      (r) => {
        res.writeHead(r.status, r.headers);
        res.end(r.body);
      },
      () => {
        // 例外の内容(個人情報を含みうる)はレスポンスにもログにも出さない
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        res.end("エラーが発生しました");
      },
    );
    return;
  }
  if (path.startsWith("/trpc/")) {
    trpc(req, res);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}).listen(port);

// eslint-disable-next-line no-console -- 起動ログ(個人情報なし)
console.log(
  `api listening on :${port}` +
    (services ? (services.vault ? "" : "(暗号化未設定: カード番号・画像の API は使えません)") : "(DATABASE_URL 未設定: 認証が必要な API は使えません)"),
);
